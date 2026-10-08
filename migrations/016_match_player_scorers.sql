-- Saving a live score asks the organizer which player scored it, so the big-screen
-- pages can show the scorer under the team name. One row per assignment: a save can
-- credit several goals or points to a player at once, and correcting a score down
-- trims the newest assignments first.
CREATE TABLE futsal_scorers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 match_id uuid NOT NULL REFERENCES futsal_matches(id) ON DELETE CASCADE,
 team_id uuid NOT NULL REFERENCES futsal_teams(id),
 player_id uuid NOT NULL REFERENCES team_players(id),
 goals integer NOT NULL CHECK (goals > 0),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX futsal_scorers_match_team ON futsal_scorers(match_id, team_id);

CREATE TABLE basketball_scorers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 match_id uuid NOT NULL REFERENCES basketball_matches(id) ON DELETE CASCADE,
 team_id uuid NOT NULL REFERENCES basketball_teams(id),
 player_id uuid NOT NULL REFERENCES team_players(id),
 points integer NOT NULL CHECK (points > 0),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX basketball_scorers_match_team ON basketball_scorers(match_id, team_id);
