// Build the expected schema from migrations/ in PGlite, then diff it against the
// live Neon schema. Read-only against live.
import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

type Probe = { label: string; sql: string };

const PROBES: Probe[] = [
  {
    label: 'columns',
    sql: `SELECT c.table_name || '.' || c.column_name AS k,
                 c.data_type || coalesce(' default ' || c.column_default, '') AS s
            FROM information_schema.columns c
           WHERE c.table_schema = 'public' AND c.table_name <> 'schema_migrations'`,
  },
  {
    label: 'constraints',
    sql: `SELECT con.conname AS k, pg_get_constraintdef(con.oid) AS s
            FROM pg_constraint con
            JOIN pg_class cl ON cl.oid = con.conrelid
            JOIN pg_namespace n ON n.oid = cl.relnamespace
           WHERE n.nspname = 'public' AND con.contype IN ('c','f','u','p')`,
  },
  {
    label: 'indexes',
    sql: `SELECT cl.relname || '.' || ic.relname AS k, pg_get_indexdef(x.indexrelid) AS s
            FROM pg_index x
            JOIN pg_class ic ON ic.oid = x.indexrelid
            JOIN pg_class cl ON cl.oid = x.indrelid
            JOIN pg_namespace n ON n.oid = cl.relnamespace
           WHERE n.nspname = 'public'`,
  },
  {
    label: 'triggers',
    sql: `SELECT cl.relname || '.' || t.tgname AS k, t.tgenabled::text AS s
            FROM pg_trigger t
            JOIN pg_class cl ON cl.oid = t.tgrelid
            JOIN pg_namespace n ON n.oid = cl.relnamespace
           WHERE n.nspname = 'public' AND NOT t.tgisinternal`,
  },
  {
    label: 'tables',
    sql: `SELECT table_name AS k, 'table' AS s
            FROM information_schema.tables
           WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  },
  {
    label: 'functions',
    sql: `SELECT p.proname AS k, 'fn' AS s
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public'`,
  },
];

const norm = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();

async function collect(q: (sql: string) => Promise<{ rows: any[] }>) {
  const out = new Map<string, Probe[]>();
  for (const probe of PROBES) {
    const rows = (await q(probe.sql)).rows;
    out.set(probe.label, rows.map((r) => ({ k: String(r.k), s: norm(r.s) })));
  }
  return out;
}

const p = new PGlite();
for (const name of (await readdir('migrations')).filter((f) => f.endsWith('.sql')).sort())
  await p.exec(await readFile(join('migrations', name), 'utf8'));
const expected = await collect((sql) => p.query(sql));

const live = new pg.Client({ connectionString: process.env.RONB_AUDIT_URL! });
await live.connect();
await live.query(`SET default_transaction_read_only = on`);
const actual = await collect((sql) => live.query(sql));

let total = 0;
for (const probe of PROBES) {
  const exp = expected.get(probe.label)!;
  const act = actual.get(probe.label)!;
  const expMap = new Map(exp.map((r) => [r.k, r.s]));
  const actMap = new Map(act.map((r) => [r.k, r.s]));

  const missing = [...expMap.keys()].filter((k) => !actMap.has(k));
  const extra = [...actMap.keys()].filter((k) => !expMap.has(k));
  const differs = [...expMap.keys()].filter((k) => actMap.has(k) && actMap.get(k) !== expMap.get(k));

  console.log(`\n=== ${probe.label}: migrations=${exp.length} live=${act.length} ===`);
  if (!missing.length && !extra.length && !differs.length) {
    console.log('  IDENTICAL');
    continue;
  }
  if (missing.length) console.log(`  MISSING IN LIVE (${missing.length}):`, missing.slice(0, 60));
  if (extra.length) console.log(`  EXTRA IN LIVE (${extra.length}):`, extra.slice(0, 60));
  for (const k of differs.slice(0, 60))
    console.log(`  DIFFERS ${k}\n    migrations: ${expMap.get(k)}\n    live      : ${actMap.get(k)}`);
  total += missing.length + extra.length + differs.length;
}

console.log(`\n=== TOTAL SCHEMA DIFFERENCES: ${total} ===`);
console.log(
  total === 0
    ? 'SAFE TO BASELINE: live schema matches migrations/ exactly.'
    : 'DO NOT BASELINE: schema diverges. Review the diff above.',
);
await live.end();
await p.close();