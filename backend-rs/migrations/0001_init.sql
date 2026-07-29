-- Naivolt v2 — initial schema
--
-- Design notes:
--   * Money is NUMERIC. Never float, never double precision.
--   * ledger_entries is append-only, enforced by trigger, not convention.
--   * Journals must balance per asset, enforced by a deferred constraint trigger
--     so a multi-statement insert can build up a journal before it is checked.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Users and wallets
-- ---------------------------------------------------------------------------

CREATE TYPE user_status AS ENUM ('active', 'frozen', 'closed');

CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- E.164, e.g. +2348012345678. Either phone or email must be present.
    phone         TEXT UNIQUE,
    email         TEXT UNIQUE,
    -- The BIP-32 address index. Assigned once, immutable, never reused:
    -- changing it would orphan every address already given to this user.
    address_index BIGINT UNIQUE NOT NULL GENERATED ALWAYS AS IDENTITY,
    pin_hash      TEXT,
    kyc_tier      SMALLINT NOT NULL DEFAULT 0,
    status        user_status NOT NULL DEFAULT 'active',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT users_need_a_contact_method CHECK (phone IS NOT NULL OR email IS NOT NULL),
    CONSTRAINT address_index_within_bip32_range CHECK (address_index < 2147483648)
);

CREATE TABLE wallets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id),
    chain           TEXT NOT NULL,
    address         TEXT NOT NULL,
    derivation_path TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One address per user per chain, and no address ever shared between users.
    UNIQUE (user_id, chain),
    UNIQUE (chain, address)
);

CREATE INDEX wallets_address_lookup ON wallets (address);

-- ---------------------------------------------------------------------------
-- Ledger
-- ---------------------------------------------------------------------------

CREATE TABLE ledger_accounts (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind       TEXT NOT NULL,
    -- NULL for platform accounts, set for user-scoped ones.
    user_id    UUID REFERENCES users(id),
    asset      TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT user_scoped_kinds_have_a_user CHECK (
        (kind IN ('user_crypto', 'user_ngn') AND user_id IS NOT NULL)
        OR (kind NOT IN ('user_crypto', 'user_ngn') AND user_id IS NULL)
    )
);

-- A user has exactly one account per (kind, asset).
CREATE UNIQUE INDEX ledger_accounts_user_unique
    ON ledger_accounts (user_id, kind, asset) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX ledger_accounts_platform_unique
    ON ledger_accounts (kind, asset) WHERE user_id IS NULL;

CREATE TABLE ledger_journals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind            TEXT NOT NULL,
    reference       TEXT NOT NULL,
    -- The retry-safety mechanism for every money path in the system.
    idempotency_key TEXT NOT NULL UNIQUE,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ledger_journals_reference ON ledger_journals (reference);
CREATE INDEX ledger_journals_created_at ON ledger_journals (created_at DESC);

CREATE TABLE ledger_entries (
    id         BIGSERIAL PRIMARY KEY,
    journal_id UUID NOT NULL REFERENCES ledger_journals(id),
    account_id UUID NOT NULL REFERENCES ledger_accounts(id),
    asset      TEXT NOT NULL,
    -- 38 digits with 18dp covers 18-decimal ETH amounts without loss.
    amount     NUMERIC(38, 18) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT entries_are_never_zero CHECK (amount <> 0)
);

CREATE INDEX ledger_entries_account_balance ON ledger_entries (account_id, asset);
CREATE INDEX ledger_entries_journal ON ledger_entries (journal_id);

-- --- Append-only enforcement ------------------------------------------------
-- Balances are derived by summing entries. If an entry could be edited or
-- deleted, history would be rewritable and the ledger worthless as an audit
-- trail. Corrections go in as reversing journals instead.

CREATE OR REPLACE FUNCTION reject_mutation() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'ledger is append-only: % on % is not permitted (post a reversing journal instead)',
        TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_no_update
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER ledger_journals_no_update
    BEFORE UPDATE OR DELETE ON ledger_journals
    FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- --- Balance enforcement ----------------------------------------------------
-- Deferred to commit time so entries can be inserted one statement at a time.

CREATE OR REPLACE FUNCTION assert_journal_balances() RETURNS TRIGGER AS $$
DECLARE
    offending RECORD;
BEGIN
    SELECT asset, SUM(amount) AS residual
      INTO offending
      FROM ledger_entries
     WHERE journal_id = NEW.journal_id
     GROUP BY asset
    HAVING SUM(amount) <> 0
     LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION
            'journal % does not balance in %: residual %',
            NEW.journal_id, offending.asset, offending.residual;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_must_balance
    AFTER INSERT ON ledger_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION assert_journal_balances();

-- Balance view. Liabilities sum negative here; the application flips the sign
-- for display (see AccountKind::user_facing_balance).
CREATE VIEW ledger_balances AS
SELECT a.id AS account_id,
       a.kind,
       a.user_id,
       a.asset,
       COALESCE(SUM(e.amount), 0) AS balance
  FROM ledger_accounts a
  LEFT JOIN ledger_entries e ON e.account_id = a.id
 GROUP BY a.id, a.kind, a.user_id, a.asset;

-- ---------------------------------------------------------------------------
-- Deposits, sweeps, quotes, payouts
-- ---------------------------------------------------------------------------

CREATE TABLE deposits (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    wallet_id           UUID NOT NULL REFERENCES wallets(id),
    chain               TEXT NOT NULL,
    -- Which EVM network it landed on: ethereum | bsc | polygon | base.
    network             TEXT NOT NULL,
    asset               TEXT NOT NULL,
    tx_hash             TEXT NOT NULL,
    -- Log index for token transfers, vout for Bitcoin. One tx can carry several
    -- deposits, so the hash alone is not a unique key.
    output_index        INTEGER NOT NULL DEFAULT 0,
    amount              NUMERIC(38, 18) NOT NULL CHECK (amount > 0),
    block_number        BIGINT NOT NULL,
    confirmations       INTEGER NOT NULL DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'seen',
    credited_journal_id UUID REFERENCES ledger_journals(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- The idempotency guarantee for the watchers: replaying a block is harmless.
    UNIQUE (chain, tx_hash, output_index)
);

CREATE INDEX deposits_pending_confirmation ON deposits (status, chain)
    WHERE status IN ('seen', 'confirming');
CREATE INDEX deposits_by_user ON deposits (user_id, created_at DESC);

CREATE TABLE sweeps (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id      UUID NOT NULL REFERENCES wallets(id),
    asset          TEXT NOT NULL,
    amount         NUMERIC(38, 18) NOT NULL CHECK (amount > 0),
    destination    TEXT NOT NULL,
    gas_funding_tx TEXT,
    sweep_tx       TEXT,
    -- pending -> gas_funded -> broadcast -> confirmed | failed
    status         TEXT NOT NULL DEFAULT 'pending',
    -- NULL when the sweeper triggered it automatically.
    initiated_by   UUID,
    journal_id     UUID REFERENCES ledger_journals(id),
    error          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only one sweep in flight per wallet+asset: a second concurrent sweep would
-- double-spend the same balance.
CREATE UNIQUE INDEX sweeps_one_in_flight_per_wallet
    ON sweeps (wallet_id, asset)
    WHERE status IN ('pending', 'gas_funded', 'broadcast');

CREATE TABLE quotes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id),
    asset       TEXT NOT NULL,
    amount      NUMERIC(38, 18) NOT NULL CHECK (amount > 0),
    -- NGN per unit, already net of spread.
    rate        NUMERIC(20, 4) NOT NULL CHECK (rate > 0),
    ngn_value   NUMERIC(20, 4) NOT NULL CHECK (ngn_value > 0),
    expires_at  TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX quotes_live ON quotes (user_id, expires_at) WHERE consumed_at IS NULL;

CREATE TABLE bank_accounts (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 UUID NOT NULL REFERENCES users(id),
    bank_code               TEXT NOT NULL,
    account_number          TEXT NOT NULL,
    account_name            TEXT NOT NULL,
    paystack_recipient_code TEXT,
    verified_at             TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (user_id, bank_code, account_number)
);

CREATE TABLE payouts (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                UUID NOT NULL REFERENCES users(id),
    bank_account_id        UUID NOT NULL REFERENCES bank_accounts(id),
    amount_ngn             NUMERIC(20, 4) NOT NULL CHECK (amount_ngn > 0),
    fee_ngn                NUMERIC(20, 4) NOT NULL DEFAULT 0,
    -- reserved -> processing -> settled | failed | reversed
    status                 TEXT NOT NULL DEFAULT 'reserved',
    -- Sent to Paystack as the transfer reference; unique, so a retried request
    -- can never pay the same person twice.
    provider_reference     TEXT NOT NULL UNIQUE,
    provider_transfer_code TEXT,
    reserved_journal_id    UUID REFERENCES ledger_journals(id),
    settled_journal_id     UUID REFERENCES ledger_journals(id),
    failure_reason         TEXT,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX payouts_in_flight ON payouts (status, created_at)
    WHERE status IN ('reserved', 'processing');
CREATE INDEX payouts_by_user ON payouts (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Audit log — hash-chained so tampering is detectable
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
    id          BIGSERIAL PRIMARY KEY,
    actor_type  TEXT NOT NULL,   -- admin | user | system
    actor_id    UUID,
    action      TEXT NOT NULL,
    target      TEXT,
    before      JSONB,
    after       JSONB,
    ip          INET,
    prev_hash   TEXT,
    hash        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER audit_log_no_update
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE INDEX audit_log_actor ON audit_log (actor_type, actor_id, created_at DESC);
