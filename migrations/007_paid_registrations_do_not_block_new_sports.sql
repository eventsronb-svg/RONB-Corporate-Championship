-- Each registration covers one sport, so a company enters additional sports with
-- fresh registrations. Confirmed and contacted (paid) orders no longer count as
-- "open" for the one-open-order-per-user invariant; only genuinely in-progress
-- registrations still do.
DROP INDEX one_open_order_per_user;
CREATE UNIQUE INDEX one_open_order_per_user ON orders(user_id)
 WHERE status NOT IN ('confirmed', 'contacted', 'completed', 'cancelled', 'expired', 'rejected');