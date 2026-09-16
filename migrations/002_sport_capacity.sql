ALTER TABLE sports ADD COLUMN IF NOT EXISTS max_teams integer;

UPDATE sports
SET max_teams = CASE name
  WHEN 'Futsal' THEN 32
  WHEN 'Crickshal' THEN 20
  WHEN 'Basketball' THEN 16
  ELSE max_teams
END
WHERE max_teams IS NULL;

ALTER TABLE sports
  ADD CONSTRAINT sports_max_teams_positive CHECK (max_teams IS NULL OR max_teams > 0);
