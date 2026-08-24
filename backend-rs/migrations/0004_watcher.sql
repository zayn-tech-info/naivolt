-- Chain watching: cursors, reorg safety, and the token registry.

-- Where each watcher has read up to.
--
-- One row per *network*, not per chain family: Ethereum, BSC, Polygon and Base
-- share one derivation path and one address, but they are four separate chains
-- with independent block heights. A single EVM cursor would make one network's
-- progress skip blocks on another.
CREATE TABLE chain_cursors (
    network          TEXT PRIMARY KEY,
    chain            TEXT NOT NULL,
    -- Last block fully processed. Restart resumes from here; reprocessing is
    -- harmless because deposit insertion is idempotent.
    last_block       BIGINT NOT NULL,
    -- Hash of that block, so a reorg is detectable: if the chain now reports a
    -- different hash at this height, history was rewritten under us.
    last_block_hash  TEXT,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which contract is which token, per network.
--
-- A deposit is only credited if the emitting contract is in this table. Without
-- it, anyone can deploy a worthless token, name it "USDT", transfer a billion to
-- a user's deposit address, and have us credit it as real money.
CREATE TABLE token_contracts (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    network       TEXT NOT NULL,
    asset         TEXT NOT NULL,
    -- Lowercased for EVM, base58 for TRON. NULL means the network's native coin.
    contract      TEXT,
    decimals      SMALLINT NOT NULL CHECK (decimals BETWEEN 0 AND 36),
    is_active     BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX token_contracts_unique
    ON token_contracts (network, COALESCE(contract, 'native'));
CREATE INDEX token_contracts_lookup ON token_contracts (network, contract) WHERE is_active;

-- Deposits gain the network they landed on and reorg bookkeeping.
ALTER TABLE deposits
    ADD COLUMN IF NOT EXISTS block_hash TEXT,
    -- Set when a credited deposit is later found to have been reorged away.
    ADD COLUMN IF NOT EXISTS reversed_journal_id UUID REFERENCES ledger_journals(id),
    ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;

-- The statuses a deposit moves through:
--   seen        → in a block, not yet at the confirmation threshold
--   confirmed   → threshold met, ledger credited
--   reversed    → was credited, then reorged away
--   ignored     → below the minimum, or an unrecognised token
ALTER TABLE deposits DROP CONSTRAINT IF EXISTS deposits_status_check;
ALTER TABLE deposits ADD CONSTRAINT deposits_status_check
    CHECK (status IN ('seen', 'confirming', 'confirmed', 'reversed', 'ignored'));

-- A credited deposit must point at the journal that credited it, and a reversed
-- one at the journal that undid it. Without this a crediting bug could leave a
-- balance with no journal behind it, which reconciliation would never explain.
ALTER TABLE deposits ADD CONSTRAINT deposits_credited_has_journal
    CHECK (status <> 'confirmed' OR credited_journal_id IS NOT NULL);
ALTER TABLE deposits ADD CONSTRAINT deposits_reversed_has_journal
    CHECK (status <> 'reversed' OR reversed_journal_id IS NOT NULL);

CREATE INDEX deposits_awaiting_confirmation
    ON deposits (network, block_number)
    WHERE status IN ('seen', 'confirming');

-- Seed the mainnet contracts we credit. Addresses are lowercased for EVM so the
-- watcher can compare without case folding on every log.
INSERT INTO token_contracts (network, asset, contract, decimals) VALUES
    ('tron',     'USDT', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',           6),
    ('tron',     'TRX',  NULL,                                            6),
    ('ethereum', 'USDT', '0xdac17f958d2ee523a2206206994597c13d831ec7',    6),
    ('ethereum', 'USDC', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',    6),
    ('ethereum', 'ETH',  NULL,                                           18),
    ('bsc',      'USDT', '0x55d398326f99059ff775485246999027b3197955',   18),
    ('bsc',      'BNB',  NULL,                                           18),
    ('polygon',  'USDT', '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',    6),
    ('polygon',  'USDC', '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',    6),
    ('base',     'USDC', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',    6),
    ('base',     'ETH',  NULL,                                           18),
    ('bitcoin',  'BTC',  NULL,                                            8),
    ('solana',   'SOL',  NULL,                                            9),
    ('solana',   'USDC', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',  6)
ON CONFLICT DO NOTHING;
