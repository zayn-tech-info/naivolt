-- The catalogue stops being a hand-written list.
--
-- 0008 seeded 12 products across 6 countries because someone typed them in.
-- 5SIM actually offers 153 countries and, depending on the country, between 200
-- and 779 products — around a thousand distinct services in total. Typing those
-- in is not an option, and neither is keeping them current by hand.
--
-- So the sync discovers them: it reads the supplier's own country list and
-- per-country product list, and inserts what it finds. These indexes are what
-- that needs to be idempotent, and what the search endpoints need to stay fast
-- once the tables hold ~75,000 price rows instead of 72.

-- Upsert keys. The sync matches on the supplier's identifier, not ours, because
-- that is the only thing it knows when a product first appears.
CREATE UNIQUE INDEX IF NOT EXISTS number_products_provider_key
    ON number_products (provider_product);
CREATE UNIQUE INDEX IF NOT EXISTS number_countries_provider_key
    ON number_countries (provider_country);

-- "Which countries sell this product, cheapest first" — the second step of the
-- buying flow, and the query that would otherwise scan every price row.
CREATE INDEX IF NOT EXISTS number_prices_by_product
    ON number_prices (product_id, price_ngn)
    WHERE active AND stock > 0;

-- "What can I buy at all", for the product list and its search.
CREATE INDEX IF NOT EXISTS number_prices_in_stock
    ON number_prices (product_id)
    WHERE active AND stock > 0;

-- Search is by name, case-insensitively, over ~1,000 rows.
CREATE INDEX IF NOT EXISTS number_products_name_lower
    ON number_products (lower(name));

-- Discovered products sort after the curated ones, which keep the sort_order
-- 0008 gave them. A product nobody has heard of should not lead the list just
-- because the supplier returned it first.
ALTER TABLE number_products ALTER COLUMN sort_order SET DEFAULT 500;
ALTER TABLE number_countries ALTER COLUMN sort_order SET DEFAULT 500;

-- Which of the supplier's operators the price came from, and when a product was
-- last actually on sale. Both are for the operator reading the table later:
-- "no stock" and "never seen" look identical without the second one.
ALTER TABLE number_prices
    ADD COLUMN IF NOT EXISTS last_in_stock_at TIMESTAMPTZ;
