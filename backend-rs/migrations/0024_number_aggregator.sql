-- Aggregate numbers across several suppliers and rank them on what actually
-- happened, not on what the supplier publishes about itself.
--
-- Why: the buy loop ordered sources `provider_cost ASC`, so every purchase
-- walked the cheapest operator first. On 5SIM the cheap operators sell a
-- number and then never deliver an SMS, which is why only the expensive picks
-- appeared to work. Cost is now the tiebreak, never the ranking.

-- 1. More suppliers than the original three.
ALTER TABLE number_offer_sources
    DROP CONSTRAINT number_offer_sources_provider_check;

ALTER TABLE number_offer_sources
    ADD CONSTRAINT number_offer_sources_provider_check
    CHECK (provider IN ('fivesim', 'smspool', 'smsactivate', 'daisysms', 'smshub', 'tigersms', 'stub'));

-- 2. Remember which SKU actually filled an order. `provider` alone cannot say
--    which operator delivered, and reliability is an operator-level fact.
ALTER TABLE number_orders
    ADD COLUMN source_product  TEXT,
    ADD COLUMN source_country  TEXT,
    ADD COLUMN source_operator TEXT;

-- 3. Observed reliability is derived from the orders themselves, not from a
--    counter table. The order row already records who filled it, whether a
--    number was handed over (phone_number) and whether an SMS ever arrived
--    (received_at), so:
--
--      attempts  = orders on that SKU that got a number
--      delivered = those where an SMS actually arrived
--
--    Deriving beats incrementing here: there is no double-count to guard, a
--    replayed or reconciled order corrects itself, and a backfill is a plain
--    UPDATE. This index is what makes the rolling-window aggregate cheap.
CREATE INDEX number_orders_source_reliability
    ON number_orders (provider, source_product, source_country, source_operator, created_at)
    WHERE source_product IS NOT NULL AND phone_number IS NOT NULL;

-- 4. One row per supplier instead of a column per supplier, so adding the next
--    one is an INSERT rather than a migration against a widening table.
CREATE TABLE number_sell_providers (
    provider   TEXT PRIMARY KEY,
    enabled    BOOLEAN NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Carry the live flags across rather than reseeding, so a deploy cannot
-- silently switch a supplier back on.
INSERT INTO number_sell_providers (provider, enabled)
SELECT 'fivesim', fivesim_enabled FROM number_sell_settings WHERE id = 1;

INSERT INTO number_sell_providers (provider, enabled)
SELECT 'smspool', smspool_enabled FROM number_sell_settings WHERE id = 1;

-- New suppliers start off: no API key is configured yet, and a listed source
-- we cannot buy from is worse than one we do not list.
INSERT INTO number_sell_providers (provider, enabled) VALUES
    ('smsactivate', false),
    ('daisysms',    false),
    ('smshub',      false),
    ('tigersms',    false);

-- `number_sell_settings` stays as the historical record of the two-supplier
-- era. Nothing reads it after this migration; `number_sell_providers` is the
-- single source of truth.
