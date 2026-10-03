CREATE TABLE basketball_teams (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 order_item_id uuid NOT NULL UNIQUE REFERENCES order_items(id),
 team_name text NOT NULL,
 logo_url text,
 group_code text CHECK (group_code ~ '^[A-D]$'),
 selected boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE basketball_matches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 stage text NOT NULL CHECK (stage IN ('group','quarter','semi','final')),
 group_code text CHECK (group_code IS NULL OR group_code ~ '^[A-D]$'),
 bracket_position integer,
 home_team_id uuid REFERENCES basketball_teams(id),
 away_team_id uuid REFERENCES basketball_teams(id),
 home_score integer NOT NULL DEFAULT 0 CHECK (home_score >= 0),
 away_score integer NOT NULL DEFAULT 0 CHECK (away_score >= 0),
 winner_team_id uuid REFERENCES basketball_teams(id),
 status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','completed','postponed')),
 version integer NOT NULL DEFAULT 1,
 completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((stage = 'group') = (group_code IS NOT NULL)),
 CHECK (home_team_id IS NULL OR away_team_id IS NULL OR home_team_id <> away_team_id)
);
CREATE UNIQUE INDEX basketball_group_pair ON basketball_matches(group_code,home_team_id,away_team_id) WHERE stage='group';
CREATE UNIQUE INDEX basketball_bracket_slot ON basketball_matches(stage,bracket_position) WHERE stage <> 'group';
CREATE INDEX basketball_matches_status ON basketball_matches(status,stage,group_code);
