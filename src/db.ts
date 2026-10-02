import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export type Row = Record<string, any>;
export interface Queryable {
  query<T extends Row = Row>(sql: string, values?: any[]): Promise<{ rows: T[] }>;
}
export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export function postgres(url: string): Database {
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
  });
  return {
    query: (sql, values) => pool.query(sql, values),
    async transaction(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const result = await fn(c);
        await c.query('COMMIT');
        return result;
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  };
}
export async function one<T extends Row = Row>(
  db: Queryable,
  sql: string,
  values: any[] = [],
): Promise<T | undefined> {
  return (await db.query<T>(sql, values)).rows[0];
}
export async function migrate(db: Database) {
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(427190)');
    await tx.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const name of (await readdir(resolve('migrations')))
      .filter((n) => n.endsWith('.sql'))
      .sort()) {
      if (await one(tx, 'SELECT name FROM schema_migrations WHERE name=$1', [name])) continue;
      // No values argument on purpose: node-postgres then uses the simple query
      // protocol, which is the only way Postgres accepts a multi-statement file.
      await tx.query(await readFile(resolve('migrations', name), 'utf8'));
      await tx.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
    }
  });
}

// Databases created before this runner existed have every table but an empty
// schema_migrations, so `migrate` would replay 001_initial.sql and abort on the
// first CREATE TABLE. Record those migrations as already applied, but only after
// confirming the database really does look like they were applied.
export async function baseline(db: Database, upTo: string) {
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(427190)');
    await tx.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const names = (await readdir(resolve('migrations')))
      .filter((n) => n.endsWith('.sql'))
      .sort();
    const upto = names.indexOf(upTo);
    if (upto < 0) throw new Error(`No such migration: ${upTo}`);
    const batch = names.slice(0, upto + 1);

    // Every table 001_initial.sql creates must already exist.
    const required = [
      'users', 'admins', 'sports', 'events', 'orders', 'order_items', 'team_players',
      'payment_requests', 'receipts', 'payment_verifications', 'order_status_history',
      'audit_logs', 'email_log', 'email_jobs', 'sessions', 'oauth_states',
    ];
    const present = new Set(
      (await tx.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema='public' AND table_type='BASE TABLE'`,
      )).rows.map((r) => r.table_name),
    );
    const missing = required.filter((t) => !present.has(t));
    if (missing.length)
      throw new Error(
        `Refusing to baseline: ${missing.length} table(s) from ${upTo} are missing (${missing.join(', ')}). ` +
          'This database was not created by these migrations.',
      );
    if (!present.has('schema_migrations'))
      throw new Error('schema_migrations was not created');

    for (const name of batch)
      await tx.query(
        'INSERT INTO schema_migrations(name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
        [name],
      );
    return batch;
  });
}
