-- Cricksal runs the same championship shape as basketball: four groups of five,
-- then the top two from each group in an eight-team knockout bracket. A cricket
-- scoreline only reads right with all three numbers, so each side keeps its runs,
-- its wickets and the overs it faced alongside the usual status bookkeeping.
CREATE TABLE cricket_teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id uuid NOT NULL UNIQUE REFERENCES order_items(id),
  team_name text NOT NULL,
  logo_url text,
  group_code text CHECK (group_code ~ '^[A-D]$'),
  selected boolean NOT NULL DEFAULT false,
  group_assigned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cricket_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage text NOT NULL CHECK (stage IN ('group','quarter','semi','final')),
  group_code text CHECK (group_code IS NULL OR group_code ~ '^[A-D]$'),
  group_position smallint,
  bracket_position integer,
  home_team_id uuid REFERENCES cricket_teams(id),
  away_team_id uuid REFERENCES cricket_teams(id),
  home_score integer NOT NULL DEFAULT 0 CHECK (home_score >= 0),
  away_score integer NOT NULL DEFAULT 0 CHECK (away_score >= 0),
  home_wickets smallint NOT NULL DEFAULT 0 CHECK (home_wickets BETWEEN 0 AND 10),
  away_wickets smallint NOT NULL DEFAULT 0 CHECK (away_wickets BETWEEN 0 AND 10),
  home_overs numeric(4,1) NOT NULL DEFAULT 0 CHECK (home_overs >= 0 AND home_overs < 100),
  away_overs numeric(4,1) NOT NULL DEFAULT 0 CHECK (away_overs >= 0 AND away_overs < 100),
  winner_team_id uuid REFERENCES cricket_teams(id),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','completed','postponed')),
  version integer NOT NULL DEFAULT 1,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((stage = 'group') = (group_code IS NOT NULL)),
  CHECK (home_team_id IS NULL OR away_team_id IS NULL OR home_team_id <> away_team_id)
);
CREATE UNIQUE INDEX cricket_group_pair ON cricket_matches(group_code,home_team_id,away_team_id) WHERE stage='group';
CREATE UNIQUE INDEX cricket_bracket_slot ON cricket_matches(stage,bracket_position) WHERE stage <> 'group';
CREATE INDEX cricket_matches_status ON cricket_matches(status,stage,group_code);

-- The scorer credit answers "who scored the runs" on the big screen and in the
-- report, trimmed the same way the other sports trim theirs when a score is
-- corrected downwards.
CREATE TABLE cricket_scorers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES cricket_matches(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES cricket_teams(id),
  player_id uuid NOT NULL REFERENCES team_players(id),
  runs integer NOT NULL CHECK (runs > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cricket_scorers_match_team ON cricket_scorers(match_id, team_id);
