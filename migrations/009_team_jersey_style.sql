-- Sleeve style is a per-team choice (surfaced for crickshal in the admin UI), so it
-- lives on the order item rather than on individual players. NULL preserves
-- existing registrations and non-crickshal sports, which never show a sleeve choice.
ALTER TABLE order_items ADD COLUMN jersey_style text
  CONSTRAINT order_items_jersey_style_check
  CHECK (jersey_style IS NULL OR jersey_style IN ('full_sleeve', 'half_sleeve'));

ALTER TABLE team_players ADD COLUMN jersey_style text
  CONSTRAINT team_players_jersey_style_check
  CHECK (jersey_style IS NULL OR jersey_style IN ('full_sleeve', 'half_sleeve'));

-- 2XL was added to the roster after 005 shipped. Re-declare the original check with
-- the wider set rather than adding a second constraint, so there is still exactly one
-- rule governing jersey_size. Existing 2XL rows satisfy the new check.
ALTER TABLE team_players DROP CONSTRAINT team_players_jersey_size_check;
ALTER TABLE team_players ADD CONSTRAINT team_players_jersey_size_check
  CHECK (jersey_size IN ('S', 'M', 'L', 'XL', '2XL'));