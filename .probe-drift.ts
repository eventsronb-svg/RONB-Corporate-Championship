// Exact live DDL for the five unversioned schema objects, plus surrounding context.
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.RONB_AUDIT_URL! });
await c.connect();
await c.query(`SET default_transaction_read_only = on`);
const q = async (l: string, s: string) => console.log(`\n=== ${l} ===\n`, (await c.query(s)).rows);

await q('new columns in full', `SELECT table_name, column_name, data_type, is_nullable,
   column_default, character_maximum_length
   FROM information_schema.columns
  WHERE table_schema='public' AND (column_name IN ('show_teams','jersey_style','jersey_size','key','value'))
   AND table_name IN ('events','order_items','team_players','site_settings')
  ORDER BY table_name, column_name`);

await q('site_settings table shape', `SELECT column_name, data_type, is_nullable, column_default
   FROM information_schema.columns WHERE table_schema='public' AND table_name='site_settings'
  ORDER BY ordinal_position`);

await q('site_settings constraints + indexes', `SELECT conname, contype, pg_get_constraintdef(oid) def
   FROM pg_constraint WHERE conrelid='site_settings'::regclass
  UNION ALL SELECT ic.relname, 'i', pg_get_indexdef(i.indexrelid)
   FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid='site_settings'::regclass`);

await q('site_settings rows', `SELECT * FROM site_settings ORDER BY 1`);

await q('jersey_style check constraints', `SELECT conname, pg_get_constraintdef(oid) def
   FROM pg_constraint
  WHERE conrelid IN ('order_items'::regclass,'team_players'::regclass)
    AND conname LIKE '%jersey%'`);

await q('jersey_size check + distinct data', `SELECT conname, pg_get_constraintdef(oid) def
   FROM pg_constraint WHERE conrelid='team_players'::regclass AND conname LIKE '%jersey_size%'`);

await q('actual jersey values in use', `SELECT 'team_players.jersey_size' col, jersey_size::text val, count(*) n
   FROM team_players WHERE jersey_size IS NOT NULL GROUP BY 2
  UNION ALL SELECT 'team_players.jersey_style', jersey_style::text, count(*)
   FROM team_players WHERE jersey_style IS NOT NULL GROUP BY 2
  UNION ALL SELECT 'order_items.jersey_style', jersey_style::text, count(*)
   FROM order_items WHERE jersey_style IS NOT NULL GROUP BY 2`);

await q('sports constraints (name mismatch check)', `SELECT conname, pg_get_constraintdef(oid) def
   FROM pg_constraint WHERE conrelid='sports'::regclass`);

await q('events.show_teams usage', `SELECT id, title, show_teams FROM events`);

await q('column order for the altered tables', `SELECT table_name, string_agg(column_name, ', ' ORDER BY ordinal_position) cols
   FROM information_schema.columns WHERE table_schema='public'
    AND table_name IN ('events','order_items','team_players','site_settings')
  GROUP BY table_name ORDER BY table_name`);

await c.end();