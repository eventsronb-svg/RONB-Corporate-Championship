// Production is only queried inside a READ ONLY transaction. Migrations run
// exclusively against a fresh embedded PostgreSQL instance on localhost.
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { migrate, postgres } from '../src/db.js';

process.loadEnvFile('.env');
const url = new URL(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || '');
if (url.hostname.endsWith('.neon.tech')) url.hostname = url.hostname.replace('-pooler.', '.');
const production = new pg.Client({
  connectionString: url.toString(),
  connectionTimeoutMillis: 10000,
});
const queries = {
  relations: `SELECT c.relname AS name,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,
    c.relreplident,c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f') ORDER BY c.relname`,
  columns: `SELECT c.relname AS table_name,a.attname AS name,a.attnum AS position,
    format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,
    pg_get_expr(d.adbin,d.adrelid) AS default_expression,a.attidentity,a.attgenerated,
    co.collname AS collation FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    LEFT JOIN pg_collation co ON co.oid=a.attcollation
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY c.relname,a.attnum`,
  // PG18 adds explicit NOT NULL catalog constraints; nullability is compared above.
  constraints: `SELECT c.relname AS table_name,k.conname AS name,k.contype,k.convalidated,
    k.condeferrable,k.condeferred,pg_get_constraintdef(k.oid) AS definition
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND k.contype<>'n' ORDER BY c.relname,k.conname`,
  indexes: `SELECT c.relname AS table_name,i.relname AS name,x.indisvalid,x.indisready,
    pg_get_indexdef(i.oid) AS definition FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid
    JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' ORDER BY c.relname,i.relname`,
  triggers: `SELECT c.relname AS table_name,t.tgname AS name,t.tgenabled,
    pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal
    ORDER BY c.relname,t.tgname`,
  functions: `SELECT p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,
    pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prokind IN ('f','p') AND NOT EXISTS
    (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
    ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)`,
  views: `SELECT c.relname AS name,pg_get_viewdef(c.oid) AS definition FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('v','m') ORDER BY c.relname`,
  policies: `SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies
    WHERE schemaname='public' ORDER BY tablename,policyname`,
  sequences: `SELECT sequencename,start_value,min_value,max_value,increment_by,cycle,cache_size
    FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`,
  enums: `SELECT t.typname AS name,e.enumlabel,e.enumsortorder FROM pg_type t
    JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid
    WHERE n.nspname='public' ORDER BY t.typname,e.enumsortorder`,
};
type QueryClient = { query: (sql: string) => Promise<{ rows: any[] }> };
async function snapshot(client: QueryClient) {
  const result: Record<string, any[]> = {};
  for (const [key, sql] of Object.entries(queries)) {
    // Line endings do not change a stored PL/pgSQL function's behavior.
    result[key] = JSON.parse(
      JSON.stringify((await client.query(sql)).rows).replace(/\\r\\n/g, '\\n'),
    );
  }
  return result;
}
const socket = createServer();
await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
const port = (socket.address() as { port: number }).port;
await new Promise<void>((resolve) => socket.close(() => resolve()));
const dir = await mkdtemp(join(tmpdir(), 'ronb-schema-check-'));
const embedded = new EmbeddedPostgres({
  databaseDir: join(dir, 'db'),
  port,
  user: 'postgres',
  password: 'local-schema-only',
  persistent: false,
  postgresFlags: ['-h', '127.0.0.1'],
  onLog: () => {},
  onError: () => {},
});
let reference: ReturnType<typeof postgres> | undefined;
try {
  await embedded.initialise();
  await embedded.start();
  await embedded.createDatabase('schema_reference_test');
  reference = postgres(
    `postgresql://postgres:local-schema-only@127.0.0.1:${port}/schema_reference_test`,
  );
  await migrate(reference);
  const expected = await snapshot(reference);
  await production.connect();
  await production.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await production.query("SET LOCAL statement_timeout='30s'");
  const readOnly = (await production.query('SHOW transaction_read_only')).rows[0]
    .transaction_read_only;
  if (readOnly !== 'on') throw new Error('Production transaction is not read-only');
  const actual = await snapshot(production);
  const differences = Object.keys(queries).filter(
    (key) => JSON.stringify(expected[key]) !== JSON.stringify(actual[key]),
  );
  const names = (await readdir('migrations')).filter((n) => n.endsWith('.sql')).sort();
  const applied = (
    await production.query('SELECT name FROM schema_migrations ORDER BY name')
  ).rows.map((r) => r.name);
  const migrationMatch = JSON.stringify(names) === JSON.stringify(applied);
  const sports = (await production.query('SELECT name,max_teams,active FROM sports ORDER BY name'))
    .rows;
  const capacityMatch =
    sports.find((s) => s.name === 'Futsal')?.max_teams === 24 &&
    sports.find((s) => s.name === 'Cricksal' || s.name === 'Crickshal')?.max_teams === 16 &&
    sports.find((s) => s.name === 'Basketball')?.max_teams === 16;
  const integrity = (
    await production.query(`SELECT
    (SELECT count(*)::int FROM pg_constraint k JOIN pg_namespace n ON n.oid=k.connamespace
      WHERE n.nspname='public' AND NOT k.convalidated) AS unvalidated_constraints,
    (SELECT count(*)::int FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND (NOT i.indisvalid OR NOT i.indisready)) AS invalid_indexes`)
  ).rows[0];
  await production.query('COMMIT');
  const report = {
    checked_at: new Date().toISOString(),
    production_read_only: true,
    scope:
      'Application public schema; excludes managed ownership, grants, extension internals, and database settings.',
    migration_match: migrationMatch,
    applied_migrations: applied,
    capacity_match: capacityMatch,
    sports,
    integrity,
    differences,
    counts: Object.fromEntries(
      Object.keys(queries).map((key) => [
        key,
        { expected: expected[key].length, actual: actual[key].length },
      ]),
    ),
    expected,
    actual,
  };
  await mkdir('playwright-report', { recursive: true });
  await writeFile(
    'playwright-report/production-schema-verification.json',
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify({ ...report, expected: undefined, actual: undefined }, null, 2));
  if (
    differences.length ||
    !migrationMatch ||
    !capacityMatch ||
    integrity.unvalidated_constraints ||
    integrity.invalid_indexes
  )
    process.exitCode = 1;
} finally {
  await production.end();
  await reference?.close();
  await embedded.stop();
  await rm(dir, { recursive: true, force: true });
}
