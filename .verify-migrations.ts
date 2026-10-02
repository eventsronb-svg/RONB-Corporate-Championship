// Verifies src/db.ts baseline() + migrate() against a simulated pre-runner database.
// Throwaway PGlite instances only; nothing touches Neon.
import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const NAMES = (await readdir('migrations')).filter((f) => f.endsWith('.sql')).sort();
const SRC = new Map<string, string>();
for (const n of NAMES) SRC.set(n, await readFile(join('migrations', n), 'utf8'));

let failures = 0;
const check = (ok: boolean, label: string, detail: unknown = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? ` -> ${detail}` : ''}`);
  if (!ok) failures++;
};

// Adapters so the real src/db.ts functions drive PGlite unchanged.
type Tx = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>;
};
const asDb = (p: PGlite) =>
  ({
    // PGlite rejects multi-statement SQL that carries a values array, while
    // node-postgres accepts it. Route through exec() when the SQL is a whole
    // migration file (more than one statement), query() otherwise, and always
    // return a { rows } shape because src/db.ts reads .rows off every call.
    const run = async (sql: string, values?: unknown[]) => {
      if (values !== undefined) return p.query(sql, values as any[]);
      const statements = sql.split(';').filter((s) => s.trim() && !/^\s*(--|\/\*)/.test(s));
      if (statements.length > 1) {
        const out = await p.exec(sql);
        return { rows: [] as any[], ...(out as object) };
      }
      return p.query(sql);
    };
    query: run,
    close: async () => {},
  }) as never;

const { baseline, migrate } = await import('./src/db.js');

const PROBE = [
  ['columns', `SELECT c.table_name||'.'||c.column_name k, c.data_type||coalesce(' default '||c.column_default,'') s
     FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name<>'schema_migrations'`],
  ['constraints', `SELECT con.conname k, pg_get_constraintdef(con.oid) s FROM pg_constraint con
     JOIN pg_class cl ON cl.oid=con.conrelid JOIN pg_namespace n ON n.oid=cl.relnamespace
    WHERE n.nspname='public' AND con.contype IN ('c','f','u','p')`],
  ['indexes', `SELECT cl.relname||'.'||ic.relname k, pg_get_indexdef(x.indexrelid) s FROM pg_index x
     JOIN pg_class ic ON ic.oid=x.indexrelid JOIN pg_class cl ON cl.oid=x.indrelid
     JOIN pg_namespace n ON n.oid=cl.relnamespace WHERE n.nspname='public'`],
  ['triggers', `SELECT cl.relname||'.'||t.tgname k, t.tgenabled::text s FROM pg_trigger t
     JOIN pg_class cl ON cl.oid=t.tgrelid JOIN pg_namespace n ON n.oid=cl.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal`],
  ['functions', `SELECT p.proname k, 'fn' s FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public'`],
] as const;
const norm = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();
async function snap(p: PGlite) {
  const out = new Map<string, string>();
  for (const [label, sql] of PROBE)
    for (const r of (await p.query(sql)).rows as any[]) out.set(`${label}:${r.k}`, norm(r.s));
  return out;
}
function diff(a: Map<string, string>, b: Map<string, string>) {
  return [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k));
}

const SEED = `
INSERT INTO users(id,google_id,email,name) VALUES
  ('11111111-1111-1111-1111-111111111111','g1','drift@test.local','Drift User');
INSERT INTO sports(id,name,price) VALUES
  ('22222222-2222-2222-2222-222222222222','Drift Sport',1000);
INSERT INTO orders(id,user_id,status) VALUES
  ('33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111','draft');
INSERT INTO order_items(id,order_id,sport_id,price_at_purchase,team_name) VALUES
  ('44444444-4444-4444-4444-444444444444','33333333-3333-3333-3333-333333333333',
   '22222222-2222-2222-2222-222222222222',5000,'Drift Team');
INSERT INTO team_players(id,order_item_id,player_name,position,jersey_size) VALUES
  ('55555555-5555-5555-5555-555555555555','44444444-4444-4444-4444-444444444444','Existing Player',0,'2XL');
INSERT INTO events(id,title,start_date,end_date,venue) VALUES
  ('66666666-6666-6666-6666-666666666666','Drift Event',now(),now(),'Kathmandu');
-- Invoice last: freeze_items rejects item inserts once the parent is invoiced.
UPDATE orders SET total_amount=5000, invoiced_at=now()
 WHERE id='33333333-3333-3333-3333-333333333333';
`;

// The clean target: 001-010 applied in order.
const clean = new PGlite();
for (const n of NAMES) await clean.exec(SRC.get(n)!);
const cleanSnap = await snap(clean);

// Production as it actually exists: 001-008 applied, then hand-run DDL for the drift.
const drifted = new PGlite();
for (const n of NAMES.filter((n) => Number(n.slice(0, 3)) <= 8)) await drifted.exec(SRC.get(n)!);
await drifted.exec(
  `ALTER TABLE team_players DROP CONSTRAINT team_players_jersey_size_check;
   ALTER TABLE team_players ADD CONSTRAINT team_players_jersey_size_check
     CHECK (jersey_size IN ('S','M','L','XL','2XL'));
   ALTER TABLE events ADD COLUMN show_teams boolean NOT NULL DEFAULT true;
   CREATE TABLE site_settings (key text PRIMARY KEY, value boolean NOT NULL);
   INSERT INTO site_settings(key,value) VALUES ('show_teams_section', false);
   ALTER TABLE order_items ADD COLUMN jersey_style text
     CONSTRAINT order_items_jersey_style_check
     CHECK (jersey_style IS NULL OR jersey_style IN ('full_sleeve','half_sleeve'));
   ALTER TABLE team_players ADD COLUMN jersey_style text
     CONSTRAINT team_players_jersey_style_check
     CHECK (jersey_style IS NULL OR jersey_style IN ('full_sleeve','half_sleeve'));
   ALTER TABLE sports ADD CONSTRAINT sports_max_teams_check CHECK (max_teams IS NULL OR max_teams > 0);`,
);
for (const stmt of SEED.split(';').map((s) => s.trim()).filter(Boolean))
  await drifted.exec(`${stmt};`);

// This is the whole point: without baseline, migrate() dies on 001.
console.log('=== migrate() on an untracked database (expected to fail) ===');
let failedAsExpected = false;
try {
  await migrate(asDb(drifted));
} catch (e: any) {
  failedAsExpected = /already exists/.test(e.message);
  console.log(`  got: ${e.message.split('\n')[0].slice(0, 70)}`);
}
check(failedAsExpected, 'migrate() alone fails on CREATE TABLE users');

console.log('\n=== baseline() then migrate() ===');
const marked = await baseline(asDb(drifted), '008_player_photos.sql');
console.log(`  baseline returned: ${JSON.stringify(marked)}`);
const recordedBy = (await drifted.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(
  (r: any) => r.name,
);
console.log(`  baseline actually recorded: ${recordedBy.join(', ')}`);
check(recordedBy.length === 8, 'recorded 001-008 in the database', recordedBy.length);

await migrate(asDb(drifted));
const recorded = (await drifted.query('SELECT name FROM schema_migrations ORDER BY name')).rows
  .map((r: any) => r.name);
console.log(`  schema_migrations now holds: ${recorded.join(', ')}`);
check(recorded.length === NAMES.length, `all ${NAMES.length} migrations recorded`, recorded.length);

const driftLeft = diff(cleanSnap, await snap(drifted));
console.log(`\n  schema differences vs a clean 001-010 database: ${driftLeft.length}`);
for (const k of driftLeft) console.log(`    ${k}`);
check(driftLeft.length === 0, 'converged exactly', driftLeft.join(', '));

console.log('\n  data checks:');
const player = (await drifted.query(`SELECT jersey_size FROM team_players WHERE id='55555555-5555-5555-5555-555555555555'`)).rows[0];
const setting = (await drifted.query(`SELECT value FROM site_settings WHERE key='show_teams_section'`)).rows[0];
const event = (await drifted.query(`SELECT show_teams FROM events LIMIT 1`)).rows[0];
const team = (await drifted.query(`SELECT team_name FROM order_items LIMIT 1`)).rows[0];
check(player?.jersey_size === '2XL', '2XL player survived', player?.jersey_size);
check(setting?.value === false, 'site_settings kept admin FALSE, not reset to true', setting?.value);
check(event?.show_teams === true, 'existing event backfilled show_teams=true', event?.show_teams);
check(team?.team_name === 'Drift Team', 'existing order item survived', team?.team_name);

console.log('\n=== idempotency: migrate() again ===');
await migrate(asDb(drifted));
const again = (await drifted.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n;
check(again === NAMES.length, 'no duplicates, still correct', again);

console.log('\n=== baseline refuses a database that is NOT migrated ===');
const empty = new PGlite();
let refused = false;
try {
  await baseline(asDb(empty), '008_player_photos.sql');
} catch (e: any) {
  refused = /Refusing to baseline/.test(e.message);
  console.log(`  got: ${e.message.slice(0, 80)}...`);
}
check(refused, 'refuses to baseline an empty database');

console.log(`\n=== ${failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED'} ===`);
await clean.close();
await drifted.close();
await empty.close();
process.exitCode = failures ? 1 : 0;