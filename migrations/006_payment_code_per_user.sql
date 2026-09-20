-- A captain's payment remarks code is stable per account: every registration
-- from the same Google account reuses the same unique code. Move the code onto
-- the user (the one key guaranteed to persist across orders) and drop the
-- per-order uniqueness already enforced by payment_requests.order_id.
ALTER TABLE users ADD COLUMN payment_code text;
CREATE UNIQUE INDEX users_payment_code_key ON users(payment_code) WHERE payment_code IS NOT NULL;

-- Existing captains keep the earliest code already on file.
UPDATE users u
SET payment_code = earliest.unique_code
FROM (
  SELECT DISTINCT ON (o.user_id) o.user_id, p.unique_code
  FROM payment_requests p JOIN orders o ON o.id = p.order_id
  ORDER BY o.user_id, p.created_at, p.id
) earliest
WHERE u.id = earliest.user_id AND u.payment_code IS NULL;

-- The same code now appears on every payment request of the same captain.
ALTER TABLE payment_requests DROP CONSTRAINT payment_requests_unique_code_key;