-- Virtual numbers.
--
-- A user buys a one-shot number to receive a single verification code. Unlike a
-- gift card there is no human in the loop, and unlike a payout the counterparty
-- is a supplier we prepay rather than a bank. What it shares with payouts is the
-- shape that matters: naira is RESERVED before the supplier is called, and only
-- settles once the code actually arrives (ARCHITECTURE.md §8).
--
-- That ordering is what makes "no code, no charge" true rather than aspirational.
-- The money leaves the user's spendable balance immediately, so two taps on Buy
-- cannot spend it twice; and if no SMS lands, the reservation is reversed rather
-- than a compensating debit being written.
--
-- What is deliberately NOT here: a ledger leg for what the number cost us. The
-- supplier's balance currency is unconfirmed (5SIM quotes a bare number and the
-- guest API does not name the unit), and booking cost of goods against a unit we
-- are guessing at would put a wrong number in the ledger permanently. The cost
-- is recorded on the order as the supplier reported it, currency and all, and
-- reconciled against supplier float once that question is settled.

CREATE TABLE number_products (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug             TEXT NOT NULL UNIQUE,
    name             TEXT NOT NULL,
    -- The supplier's own key for this product. Ours differs on purpose: 5SIM
    -- still calls it "twitter", and our catalogue should not inherit that.
    provider_product TEXT NOT NULL,
    active           BOOLEAN NOT NULL DEFAULT true,
    sort_order       INTEGER NOT NULL DEFAULT 100,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE number_countries (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code             TEXT NOT NULL UNIQUE,
    name             TEXT NOT NULL,
    dial_code        TEXT NOT NULL,
    provider_country TEXT NOT NULL,
    -- Nigeria leads. Alphabetical ordering put Ghana first, which is a strange
    -- default for a Nigerian product; everything else falls back to by-name.
    sort_order       INTEGER NOT NULL DEFAULT 100,
    active           BOOLEAN NOT NULL DEFAULT true,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE number_prices (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id             UUID NOT NULL REFERENCES number_products(id) ON DELETE CASCADE,
    country_id             UUID NOT NULL REFERENCES number_countries(id) ON DELETE CASCADE,
    -- What we charge. Not derived from provider_cost at request time: a supplier
    -- price that moves mid-session must not move the number the user is looking at.
    price_ngn              NUMERIC(20, 4) NOT NULL CHECK (price_ngn > 0),
    -- Last observed supplier cost, in whatever unit the supplier reported.
    provider_cost          NUMERIC(20, 6),
    provider_cost_currency TEXT,
    provider_operator      TEXT,
    stock                  INTEGER NOT NULL DEFAULT 0,
    active                 BOOLEAN NOT NULL DEFAULT true,
    synced_at              TIMESTAMPTZ,
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (product_id, country_id)
);

CREATE TABLE number_orders (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                UUID NOT NULL REFERENCES users(id),
    product_id             UUID NOT NULL REFERENCES number_products(id),
    country_id             UUID NOT NULL REFERENCES number_countries(id),

    -- Captured at purchase. The user agreed to this number; a later price change
    -- must not alter what they paid, the same rule gift cards follow.
    price_ngn              NUMERIC(20, 4) NOT NULL CHECK (price_ngn > 0),

    provider               TEXT NOT NULL DEFAULT '5sim',
    provider_order_id      TEXT,
    provider_cost          NUMERIC(20, 6),
    provider_cost_currency TEXT,

    -- NULL until the supplier assigns one, which happens after the reservation.
    phone_number           TEXT,
    sms_code               TEXT,
    sms_text               TEXT,
    received_at            TIMESTAMPTZ,

    -- reserved -> awaiting_code -> delivered
    --                           -> expired | cancelled  (both refund)
    --          -> failed                                (refunds; supplier never took it)
    status                 TEXT NOT NULL DEFAULT 'reserved',
    -- When the hold lapses and the reservation is reversed.
    expires_at             TIMESTAMPTZ,

    reserved_journal_id    UUID REFERENCES ledger_journals(id),
    settled_journal_id     UUID REFERENCES ledger_journals(id),
    refunded_journal_id    UUID REFERENCES ledger_journals(id),
    failure_reason         TEXT,

    reference              TEXT NOT NULL UNIQUE,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- An order is only ever settled or refunded, never both.
    CONSTRAINT settled_or_refunded_not_both CHECK (
        settled_journal_id IS NULL OR refunded_journal_id IS NULL
    )
);

-- The sweep the poller runs: orders still waiting on a code.
CREATE INDEX number_orders_open ON number_orders (status, expires_at)
    WHERE status IN ('reserved', 'awaiting_code');
CREATE INDEX number_orders_user ON number_orders (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Seed catalogue.
--
-- Prices here are the launch card, carried over from the marketing site so the
-- API and the page agree on day one. They are a starting point, not a policy:
-- a sync against the supplier replaces provider_cost and stock, and pricing is
-- then set against real cost.

INSERT INTO number_products (slug, name, provider_product, sort_order) VALUES
    ('whatsapp',  'WhatsApp',  'whatsapp',  10),
    ('telegram',  'Telegram',  'telegram',  20),
    ('instagram', 'Instagram', 'instagram', 30),
    ('facebook',  'Facebook',  'facebook',  40),
    ('tiktok',    'TikTok',    'tiktok',    50),
    ('google',    'Google',    'google',    60),
    ('x',         'X',         'twitter',   70),
    ('discord',   'Discord',   'discord',   80),
    ('apple',     'Apple',     'apple',     90),
    ('uber',      'Uber',      'uber',     100),
    ('tinder',    'Tinder',    'tinder',   110),
    ('amazon',    'Amazon',    'amazon',   120);

INSERT INTO number_countries (code, name, dial_code, provider_country, sort_order) VALUES
    ('NG', 'Nigeria',        '+234', 'nigeria',      10),
    ('US', 'United States',  '+1',   'usa',         100),
    ('GB', 'United Kingdom', '+44',  'england',     100),
    ('GH', 'Ghana',          '+233', 'ghana',       100),
    ('ZA', 'South Africa',   '+27',  'southafrica', 100),
    ('KE', 'Kenya',          '+254', 'kenya',       100);

INSERT INTO number_prices (product_id, country_id, price_ngn)
SELECT p.id,
       c.id,
       -- Rounded to the nearest ten naira; a price ending in 7 reads like a bug.
       ROUND((base.amount * factor.multiple) / 10) * 10
  FROM number_products p
  JOIN (VALUES
        ('whatsapp', 2.4), ('telegram', 1.6), ('instagram', 1.4), ('facebook', 1.3),
        ('tiktok',   1.2), ('google',   1.8), ('x',         1.1), ('discord',  1.0),
        ('apple',    1.7), ('uber',     1.5), ('tinder',    1.9), ('amazon',   1.3)
       ) AS factor(slug, multiple) ON factor.slug = p.slug
 CROSS JOIN number_countries c
  JOIN (VALUES
        ('NG', 260), ('US', 420), ('GB', 520), ('GH', 300), ('ZA', 340), ('KE', 310)
       ) AS base(code, amount) ON base.code = c.code;
