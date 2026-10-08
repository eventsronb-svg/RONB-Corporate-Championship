-- A wicket belongs to the bowler who took it, credited player-by-player the same
-- way runs go to the batsmen. One row per credit, so correcting a score down can
-- trim the newest assignments before the older ones, exactly like the run
-- credits.
CREATE TABLE cricket_wickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES cricket_matches(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES cricket_teams(id),
  player_id uuid NOT NULL REFERENCES team_players(id),
  wickets integer NOT NULL CHECK (wickets > 0 AND wickets <= 10),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cricket_wickets_match_team ON cricket_wickets(match_id, team_id);