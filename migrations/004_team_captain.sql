-- The captain refers to one roster position, never an additional player.
ALTER TABLE order_items ADD COLUMN captain_position integer
  CHECK (captain_position >= 0 AND captain_position < 100);
