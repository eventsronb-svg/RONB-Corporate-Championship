-- Small key/value store for landing-page toggles the admin panel owns. Booleans only
-- so the API can read a setting without parsing. Missing key means "use the default",
-- which the API applies by treating an absent row as the permissive value.
CREATE TABLE IF NOT EXISTS site_settings (
  key text PRIMARY KEY,
  value boolean NOT NULL
);

-- "Meet the teams" visibility on the public landing page. Defaults to visible, so
-- existing single-event deployments keep rendering it after this migration.
ALTER TABLE events ADD COLUMN IF NOT EXISTS show_teams boolean NOT NULL DEFAULT true;

INSERT INTO site_settings (key, value) VALUES ('show_teams_section', true)
  ON CONFLICT (key) DO NOTHING;

-- 002 created sports_max_teams_positive. Production also carries an identically
-- worded sports_max_teams_check left behind by an earlier manual change; two
-- identical CHECKs enforce the same rule twice. Drop the stray one.
ALTER TABLE sports DROP CONSTRAINT IF EXISTS sports_max_teams_check;