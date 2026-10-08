-- Speed up common live/data queries for standings, brackets and live match lookups.
CREATE INDEX IF NOT EXISTS cricket_matches_live_idx ON cricket_matches(status, created_at) WHERE status='live';
CREATE INDEX IF NOT EXISTS cricket_matches_group_idx ON cricket_matches(stage, group_code, group_position);
CREATE INDEX IF NOT EXISTS cricket_matches_bracket_idx ON cricket_matches(stage, bracket_position) WHERE stage <> 'group';
CREATE INDEX IF NOT EXISTS cricket_scorers_match_team_idx ON cricket_scorers(match_id, team_id, created_at);
CREATE INDEX IF NOT EXISTS cricket_wickets_match_team_idx ON cricket_wickets(match_id, team_id, created_at);
CREATE INDEX IF NOT EXISTS cricket_scorers_match_idx ON cricket_scorers(match_id, created_at);
CREATE INDEX IF NOT EXISTS cricket_wickets_match_idx ON cricket_wickets(match_id, created_at);

CREATE INDEX IF NOT EXISTS futsal_matches_live_idx ON futsal_matches(status, created_at) WHERE status='live';
CREATE INDEX IF NOT EXISTS futsal_matches_group_idx ON futsal_matches(stage, group_code, group_position);
CREATE INDEX IF NOT EXISTS futsal_matches_bracket_idx ON futsal_matches(stage, bracket_position) WHERE stage <> 'group';
CREATE INDEX IF NOT EXISTS futsal_scorers_match_team_idx ON futsal_scorers(match_id, team_id, created_at);
CREATE INDEX IF NOT EXISTS futsal_scorers_match_idx ON futsal_scorers(match_id, created_at);

CREATE INDEX IF NOT EXISTS basketball_matches_live_idx ON basketball_matches(status, created_at) WHERE status='live';
CREATE INDEX IF NOT EXISTS basketball_matches_group_idx ON basketball_matches(stage, group_code, group_position);
CREATE INDEX IF NOT EXISTS basketball_matches_bracket_idx ON basketball_matches(stage, bracket_position) WHERE stage <> 'group';
CREATE INDEX IF NOT EXISTS basketball_scorers_match_team_idx ON basketball_scorers(match_id, team_id, created_at);
CREATE INDEX IF NOT EXISTS basketball_scorers_match_idx ON basketball_scorers(match_id, created_at);