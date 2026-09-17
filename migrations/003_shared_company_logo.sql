-- Keep one existing logo for each company within a registration. Prefer a
-- completed profile, then use the stable item ID to resolve older differences.
WITH company_logos AS (
  SELECT DISTINCT ON (order_id, team_name) order_id, team_name, logo_url
  FROM order_items
  WHERE logo_url IS NOT NULL
  ORDER BY order_id, team_name, profile_completed_at ASC NULLS LAST, id
)
UPDATE order_items AS item
SET logo_url = company.logo_url
FROM company_logos AS company
WHERE item.order_id = company.order_id
  AND item.team_name = company.team_name
  AND item.logo_url IS DISTINCT FROM company.logo_url;
