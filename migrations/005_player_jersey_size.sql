-- Sizes belong to individual roster members, including the team captain.
-- NULL preserves existing rosters and allows incomplete profile drafts.
-- The API requires a size for every player before completing a profile.
ALTER TABLE team_players ADD COLUMN jersey_size text
  CONSTRAINT team_players_jersey_size_check
  CHECK (jersey_size IN ('S', 'M', 'L', 'XL'));
