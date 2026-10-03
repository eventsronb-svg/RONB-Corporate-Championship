CREATE TABLE futsal_teams (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 order_item_id uuid NOT NULL UNIQUE REFERENCES order_items(id),
 team_name text NOT NULL,
 logo_url text,
 group_code text CHECK (group_code ~ '^[A-H]$'),
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE futsal_matches (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 stage text NOT NULL CHECK (stage IN ('group','prequarter','quarter','semi','final')),
 group_code text CHECK (group_code IS NULL OR group_code ~ '^[A-H]$'),
 bracket_position integer,
 home_team_id uuid REFERENCES futsal_teams(id),
 away_team_id uuid REFERENCES futsal_teams(id),
 home_score integer NOT NULL DEFAULT 0 CHECK (home_score >= 0),
 away_score integer NOT NULL DEFAULT 0 CHECK (away_score >= 0),
 winner_team_id uuid REFERENCES futsal_teams(id),
 status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','completed','postponed')),
 version integer NOT NULL DEFAULT 1,
 completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((stage = 'group') = (group_code IS NOT NULL)),
 CHECK (home_team_id IS NULL OR away_team_id IS NULL OR home_team_id <> away_team_id)
);
CREATE UNIQUE INDEX futsal_group_pair ON futsal_matches(group_code,home_team_id,away_team_id) WHERE stage='group';
CREATE UNIQUE INDEX futsal_bracket_slot ON futsal_matches(stage,bracket_position) WHERE stage <> 'group';
CREATE INDEX futsal_matches_status ON futsal_matches(status,stage,group_code);

CREATE TABLE futsal_tie_decisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 group_code text NOT NULL CHECK (group_code ~ '^[A-H]$'),
 higher_team_id uuid NOT NULL REFERENCES futsal_teams(id),
 lower_team_id uuid NOT NULL REFERENCES futsal_teams(id),
 reason text NOT NULL CHECK (length(trim(reason)) > 0),
 admin_id uuid NOT NULL REFERENCES admins(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (higher_team_id <> lower_team_id),
 UNIQUE(group_code,higher_team_id,lower_team_id)
);
