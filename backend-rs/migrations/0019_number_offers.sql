-- Naivolt number offers: customer facing rows plus hidden supplier SKUs.
-- number_prices stays; old catalogue and old buy keep using it.

CREATE TABLE number_offers (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id           UUID NOT NULL REFERENCES number_products(id),
    country_id           UUID NOT NULL REFERENCES number_countries(id),
    price_ngn            NUMERIC(20, 4) NOT NULL CHECK (price_ngn > 0),
    success_rate         NUMERIC(8, 4) NOT NULL CHECK (success_rate > 0 AND success_rate <= 100),
    success_fetched_at   TIMESTAMPTZ NOT NULL,
    quantity             INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    active               BOOLEAN NOT NULL DEFAULT true,
    synced_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (product_id, country_id, price_ngn, success_rate)
);

CREATE INDEX number_offers_list
    ON number_offers (product_id, success_rate DESC, price_ngn, quantity DESC)
    WHERE active AND quantity > 0;

CREATE TABLE number_offer_sources (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    offer_id                UUID NOT NULL REFERENCES number_offers(id),
    provider                TEXT NOT NULL CHECK (provider IN ('fivesim', 'smspool', 'stub')),
    provider_product        TEXT NOT NULL,
    provider_country        TEXT NOT NULL,
    provider_operator       TEXT NOT NULL DEFAULT '',
    provider_cost           NUMERIC(20, 6) NOT NULL,
    provider_cost_currency  TEXT NOT NULL,
    provider_success_rate   NUMERIC(8, 4) NOT NULL CHECK (provider_success_rate > 0 AND provider_success_rate <= 100),
    stock                   INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
    synced_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_product, provider_country, provider_operator)
);

CREATE INDEX number_offer_sources_offer ON number_offer_sources (offer_id);

ALTER TABLE number_orders
    ADD COLUMN offer_id UUID REFERENCES number_offers(id);
