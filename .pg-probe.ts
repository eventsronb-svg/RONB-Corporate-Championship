// Which queries does node-postgres send as prepared statements?
// No parameters  -> extended protocol (rejects multiple statements).
// Empty array     -> simple query protocol (accepts multiple statements).
// Uses only TEMP tables inside a transaction that is rolled back, so nothing
// persistent is created. Read-only is deliberately off for this probe.
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.RONB_AUDIT_URL! });
await c.connect();

const MULTI = 'CREATE TEMP TABLE t_probe (a int); CREATE TEMP TABLE t_probe2 (b int);';

for (const [label, run] of [
  ['no values argument', () => c.query(MULTI)],
  ['empty array argument', () => c.query(MULTI, [])],
] as const) {
  await c.query('BEGIN');
  try {
    await run();
    console.log(`  ${label}: OK - multi-statement accepted`);
  } catch (e: any) {
    console.log(`  ${label}: FAILS - ${e.message}`);
  }
  await c.query('ROLLBACK');
}

await c.end();