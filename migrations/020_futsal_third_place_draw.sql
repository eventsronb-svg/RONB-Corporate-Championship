-- A manual draw resolves only a third-place tie crossing the qualification cutoff.
-- The signature binds the draw to the candidate teams and their final statistics.
CREATE TABLE futsal_third_place_draw (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 signature text NOT NULL,
 team_ids uuid[] NOT NULL CHECK (cardinality(team_ids) = 6),
 admin_id uuid NOT NULL REFERENCES admins(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
