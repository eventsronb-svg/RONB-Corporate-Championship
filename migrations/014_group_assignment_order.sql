-- Groups are seeded by hand, so a group's fixtures must follow the order the
-- organizer placed teams in it, not the alphabetical team order. Recording the
-- assignment time keeps the drawn pairings stable for later fixtures.
ALTER TABLE futsal_teams ADD COLUMN group_assigned_at timestamptz;
ALTER TABLE basketball_teams ADD COLUMN group_assigned_at timestamptz;