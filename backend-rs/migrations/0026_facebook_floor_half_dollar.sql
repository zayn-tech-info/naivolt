-- Lower Facebook's floor from $1.00 to $0.50.
--
-- At a dollar the live catalogue had exactly one Facebook offer left: Cambodia
-- at NGN 6,880 with a published rate of 4.76%. A price floor removes cheap bad
-- stock and is powerless against expensive bad stock, so it left the shop
-- selling one number that fails roughly twenty times in twenty-one, badged as
-- the pick because it was the only row.
--
-- Half a dollar still excludes the bottom of the market while leaving enough
-- stock for the delivery ranking to choose between. That ranking learns from
-- real orders, which is the measurement price was only ever standing in for.
--
-- 0025 is left as it was: it has already run here, and sqlx checks the stored
-- checksum on boot, so a migration that has run is history rather than
-- something to edit.

UPDATE number_products
   SET min_provider_cost_usd = 0.50
 WHERE slug = 'facebook';
