-- A per-app floor on what we are willing to pay the supplier.
--
-- The relative floor in 0024 keeps the dearest tier for each app and country,
-- which is the right rule when an app's stock spans a wide range. Facebook is
-- the case it does not cover: every operator is cheap, so "dearest tier" still
-- lands on stock that takes the money and never delivers. Below a dollar,
-- Facebook numbers are not worth selling at any relative rank.
--
-- Denominated in the supplier's USD cost, not in naira: naira prices move with
-- the rate and the margin, so a naira floor would drift against the thing it is
-- actually measuring, which is how much operator the supplier is giving us.
--
-- Zero means no floor, which is every app but Facebook.

ALTER TABLE number_products
    ADD COLUMN min_provider_cost_usd NUMERIC(20, 6) NOT NULL DEFAULT 0
        CHECK (min_provider_cost_usd >= 0);

UPDATE number_products
   SET min_provider_cost_usd = 1.00
 WHERE slug = 'facebook';
