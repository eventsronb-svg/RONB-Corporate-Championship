-- Cricksal is played ten overs a side with seven wickets, not a full twenty-over
-- innings, so the scoreboard ceilings tighten. The desk also records which side
-- is in to bat: chosen when the match starts and swapped at the innings break,
-- which is what the fixtures list and the big screen read to place the bat and
-- the ball beside the right team.
ALTER TABLE cricket_matches DROP CONSTRAINT cricket_matches_home_wickets_check;
ALTER TABLE cricket_matches DROP CONSTRAINT cricket_matches_away_wickets_check;
ALTER TABLE cricket_matches ADD CONSTRAINT cricket_matches_home_wickets_check
  CHECK (home_wickets BETWEEN 0 AND 7);
ALTER TABLE cricket_matches ADD CONSTRAINT cricket_matches_away_wickets_check
  CHECK (away_wickets BETWEEN 0 AND 7);
ALTER TABLE cricket_matches DROP CONSTRAINT cricket_matches_home_overs_check;
ALTER TABLE cricket_matches DROP CONSTRAINT cricket_matches_away_overs_check;
ALTER TABLE cricket_matches ADD CONSTRAINT cricket_matches_home_overs_check
  CHECK (home_overs >= 0 AND home_overs <= 10);
ALTER TABLE cricket_matches ADD CONSTRAINT cricket_matches_away_overs_check
  CHECK (away_overs >= 0 AND away_overs <= 10);
-- One credit can never exceed a side's wicket tally, which now tops out at seven.
ALTER TABLE cricket_wickets DROP CONSTRAINT cricket_wickets_wickets_check;
ALTER TABLE cricket_wickets ADD CONSTRAINT cricket_wickets_wickets_check
  CHECK (wickets > 0 AND wickets <= 7);
ALTER TABLE cricket_matches ADD COLUMN batting_side text
  CHECK (batting_side IS NULL OR batting_side IN ('home','away'));