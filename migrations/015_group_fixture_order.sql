-- Every group fixture is drawn inside one transaction, so created_at ties across the
-- group and the random uuid id ended up deciding their order. Record the order the
-- draw produced so each group lists its matches as drawn.
ALTER TABLE futsal_matches ADD COLUMN group_position smallint;
ALTER TABLE basketball_matches ADD COLUMN group_position smallint;