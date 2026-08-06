-- Gift cards, and device push tokens.
--
-- Selling a gift card is the app's primary earner. Unlike a crypto deposit it
-- cannot be verified by a machine — a person checks the card and approves it —
-- so the flow is explicitly a review queue, and naira is credited only on
-- approval.
--
-- Rates are per brand *and country*: the same Amazon card clears at very
-- different rates depending on where it was issued, which is why country is a
-- required choice in the app rather than a detail.

CREATE TABLE gift_card_brands (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    logo_url      TEXT,
    -- Whether a photo of the card is required for review, and whether the brand
    -- issues a PIN alongside the code. Per brand so the client does not hardcode
    -- a list of which brands have PINs.
    requires_image BOOLEAN NOT NULL DEFAULT true,
    has_pin        BOOLEAN NOT NULL DEFAULT false,
    -- Operational caveat shown before submitting, e.g. "Receipt required".
    note           TEXT,
    -- Withdrawn brands stop being offered without deleting their history.
    active         BOOLEAN NOT NULL DEFAULT true,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE gift_card_rates (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand_id       UUID NOT NULL REFERENCES gift_card_brands(id) ON DELETE CASCADE,
    country_code   TEXT NOT NULL,
    country_name   TEXT NOT NULL,
    -- Face-value currency, e.g. USD. Not always the country's own currency.
    currency       TEXT NOT NULL,
    -- Naira per unit of face value. Deliberately NOT derived from the crypto
    -- rate: a card carries fraud and chargeback risk a confirmed on-chain
    -- deposit does not, and clears well below it.
    rate_per_unit  NUMERIC(20, 4) NOT NULL CHECK (rate_per_unit > 0),
    min_face_value NUMERIC(20, 2) NOT NULL DEFAULT 10,
    max_face_value NUMERIC(20, 2) NOT NULL DEFAULT 1000,
    active         BOOLEAN NOT NULL DEFAULT true,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (brand_id, country_code),
    CONSTRAINT face_value_range_is_sane CHECK (max_face_value >= min_face_value)
);

CREATE TABLE gift_card_submissions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id),
    brand_id        UUID NOT NULL REFERENCES gift_card_brands(id),
    rate_id         UUID NOT NULL REFERENCES gift_card_rates(id),

    face_value      NUMERIC(20, 2) NOT NULL CHECK (face_value > 0),
    currency        TEXT NOT NULL,
    -- The rate at submission, captured so a later rate change cannot alter what
    -- the user was quoted. They agreed to a number; that number is binding.
    rate_per_unit   NUMERIC(20, 4) NOT NULL,
    payout_ngn      NUMERIC(20, 4) NOT NULL CHECK (payout_ngn > 0),

    -- The card itself. Single-use secrets: once approved and redeemed these are
    -- worthless, and until then they are bearer instruments, so access to this
    -- table is as sensitive as access to the ledger.
    card_code       TEXT NOT NULL,
    card_pin        TEXT,
    image_url       TEXT,

    -- pending -> reviewing -> approved | rejected
    status          TEXT NOT NULL DEFAULT 'pending',
    rejection_reason TEXT,
    reviewed_by     UUID,
    reviewed_at     TIMESTAMPTZ,
    -- Set when approval credits the user. Ties the payout to the ledger so gift
    -- card liabilities appear in reconciliation rather than being a side channel.
    credited_journal_id UUID REFERENCES ledger_journals(id),

    reference       TEXT NOT NULL UNIQUE,
    -- One physical card, one submission, however many times a flaky connection
    -- retries the request.
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX gift_card_submissions_by_user ON gift_card_submissions (user_id, created_at DESC);
-- The reviewer's queue.
CREATE INDEX gift_card_submissions_pending ON gift_card_submissions (created_at)
    WHERE status IN ('pending', 'reviewing');

-- ---------------------------------------------------------------------------

CREATE TABLE device_push_tokens (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- One row per installation, not per user: someone with two phones should get
    -- both, and signing out on one must drop only that one.
    device_id  TEXT NOT NULL,
    token      TEXT NOT NULL,
    platform   TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (user_id, device_id)
);

-- ---------------------------------------------------------------------------
-- Seed brands and rates.
--
-- Rates sit well below the crypto per-dollar rate on purpose; see the note on
-- gift_card_rates. These are plausible Nigerian market values and are meant to
-- be maintained from the admin panel, not hardcoded forever.

INSERT INTO gift_card_brands (slug, name, logo_url, has_pin, note) VALUES
    ('amazon',      'Amazon',        'https://logo.clearbit.com/amazon.com',       false, 'Receipt required for cards over $200.'),
    ('itunes',      'iTunes',        'https://logo.clearbit.com/apple.com',        false, NULL),
    ('steam',       'Steam',         'https://logo.clearbit.com/steampowered.com', false, NULL),
    ('google-play', 'Google Play',   'https://logo.clearbit.com/play.google.com',  false, NULL),
    ('playstation', 'PlayStation',   'https://logo.clearbit.com/playstation.com',  false, NULL),
    ('xbox',        'Xbox',          'https://logo.clearbit.com/xbox.com',         false, NULL),
    ('sephora',     'Sephora',       'https://logo.clearbit.com/sephora.com',      false, 'US cards only.'),
    ('nike',        'Nike',          'https://logo.clearbit.com/nike.com',         false, NULL),
    ('netflix',     'Netflix',       'https://logo.clearbit.com/netflix.com',      true,  NULL),
    ('ebay',        'eBay',          'https://logo.clearbit.com/ebay.com',         false, NULL),
    ('walmart',     'Walmart',       'https://logo.clearbit.com/walmart.com',      false, NULL),
    ('vanilla',     'Vanilla / Visa','https://logo.clearbit.com/vanillagift.com',  true,  'Must show full card front and back.');

INSERT INTO gift_card_rates (brand_id, country_code, country_name, currency, rate_per_unit, min_face_value, max_face_value)
SELECT b.id, r.country_code, r.country_name, r.currency, r.rate, r.min_face, r.max_face
  FROM gift_card_brands b
  JOIN (VALUES
    ('amazon',      'US', 'United States',  'USD', 1080, 10, 1000),
    ('amazon',      'GB', 'United Kingdom', 'GBP', 1320, 10, 1000),
    ('amazon',      'CA', 'Canada',         'CAD',  880, 10, 1000),
    ('amazon',      'DE', 'Germany',        'EUR', 1150, 10, 1000),
    ('itunes',      'US', 'United States',  'USD', 1160, 10, 1000),
    ('itunes',      'GB', 'United Kingdom', 'GBP', 1280, 10, 1000),
    ('itunes',      'CA', 'Canada',         'CAD',  900, 10, 1000),
    ('steam',       'US', 'United States',  'USD', 1240, 10, 1000),
    ('steam',       'GB', 'United Kingdom', 'GBP', 1300, 10, 1000),
    ('google-play', 'US', 'United States',  'USD', 1100, 10, 1000),
    ('google-play', 'GB', 'United Kingdom', 'GBP', 1240, 10, 1000),
    ('playstation', 'US', 'United States',  'USD', 1120, 10, 1000),
    ('playstation', 'GB', 'United Kingdom', 'GBP', 1260, 10, 1000),
    ('xbox',        'US', 'United States',  'USD', 1040, 10, 1000),
    ('xbox',        'GB', 'United Kingdom', 'GBP', 1180, 10, 1000),
    ('sephora',     'US', 'United States',  'USD', 1290, 10, 1000),
    ('nike',        'US', 'United States',  'USD', 1200, 10, 1000),
    ('netflix',     'US', 'United States',  'USD',  980, 10, 1000),
    ('ebay',        'US', 'United States',  'USD', 1020, 10, 1000),
    ('walmart',     'US', 'United States',  'USD', 1060, 10, 1000),
    ('vanilla',     'US', 'United States',  'USD',  890, 25,  500)
  ) AS r(slug, country_code, country_name, currency, rate, min_face, max_face)
    ON r.slug = b.slug;
