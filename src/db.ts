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
      await tx.query(await readFile(resolve('migrations', name), 'utf8'));
      await tx.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
    }
  });
}
