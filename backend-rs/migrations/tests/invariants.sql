-- Schema invariant tests. Run against a database with 0001_init.sql applied:
--   psql -v ON_ERROR_STOP=1 -d naivolt_test -f migrations/tests/invariants.sql
--
-- Each block asserts that an *illegal* operation is rejected. A silent pass here
-- would mean the ledger's guarantees exist only in the Rust layer.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO users (phone) VALUES ('+2348012345678');

INSERT INTO ledger_accounts (kind, user_id, asset)
SELECT 'user_ngn', id, 'NGN' FROM users WHERE phone = '+2348012345678';
INSERT INTO ledger_accounts (kind, asset) VALUES ('ngn_float', 'NGN');

INSERT INTO ledger_journals (kind, reference, idempotency_key)
VALUES ('deposit_credit', 'test', 'test-key-1');

INSERT INTO ledger_entries (journal_id, account_id, asset, amount)
SELECT j.id, a.id, 'NGN', 1000
  FROM ledger_journals j, ledger_accounts a
 WHERE j.idempotency_key = 'test-key-1' AND a.kind = 'ngn_float';

INSERT INTO ledger_entries (journal_id, account_id, asset, amount)
SELECT j.id, a.id, 'NGN', -1000
  FROM ledger_journals j, ledger_accounts a
 WHERE j.idempotency_key = 'test-key-1' AND a.kind = 'user_ngn';

-- Committed setup for the sweep test below. It has to live out here: a
-- PL/pgSQL EXCEPTION handler rolls back to the start of its block, so anything
-- inserted inside an assertion block is gone by the time the next one runs.
INSERT INTO wallets (user_id, chain, address, derivation_path)
SELECT id, 'tron', 'TSweepTestWallet', 'm/44''/195''/0''/0/0'
  FROM users WHERE phone = '+2348012345678';

COMMIT;  -- balanced journal: must succeed

\echo '  ok: balanced journal commits'

-- 1. An unbalanced journal must be rejected at COMMIT, not silently stored.
DO $$
DECLARE
    jid UUID;
    aid UUID;
BEGIN
    INSERT INTO ledger_journals (kind, reference, idempotency_key)
    VALUES ('sell', 'test', 'test-key-unbalanced') RETURNING id INTO jid;

    SELECT id INTO aid FROM ledger_accounts WHERE kind = 'ngn_float';
    INSERT INTO ledger_entries (journal_id, account_id, asset, amount)
    VALUES (jid, aid, 'NGN', 500);

    -- Force the deferred constraint to evaluate now.
    SET CONSTRAINTS ledger_entries_must_balance IMMEDIATE;
    RAISE EXCEPTION 'FAIL: unbalanced journal was accepted';
EXCEPTION
    WHEN raise_exception THEN
        IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF;
        RAISE NOTICE '  ok: unbalanced journal rejected (%)', left(SQLERRM, 60);
END $$;

-- 2. Ledger entries must be immutable.
DO $$
BEGIN
    UPDATE ledger_entries SET amount = 999999;
    RAISE EXCEPTION 'FAIL: ledger entry was updated';
EXCEPTION
    WHEN raise_exception THEN
        IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF;
        RAISE NOTICE '  ok: UPDATE on ledger_entries rejected';
END $$;

DO $$
BEGIN
    DELETE FROM ledger_entries;
    RAISE EXCEPTION 'FAIL: ledger entry was deleted';
EXCEPTION
    WHEN raise_exception THEN
        IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF;
        RAISE NOTICE '  ok: DELETE on ledger_entries rejected';
END $$;

-- 3. Idempotency keys must be unique — this is what stops double payouts.
DO $$
BEGIN
    INSERT INTO ledger_journals (kind, reference, idempotency_key)
    VALUES ('sell', 'test', 'test-key-1');
    RAISE EXCEPTION 'FAIL: duplicate idempotency key was accepted';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE '  ok: duplicate idempotency key rejected';
END $$;

-- 4. A platform account must not be user-scoped, and vice versa.
DO $$
BEGIN
    INSERT INTO ledger_accounts (kind, user_id, asset)
    SELECT 'custody_hot', id, 'USDT' FROM users LIMIT 1;
    RAISE EXCEPTION 'FAIL: custody account was allowed a user_id';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE '  ok: custody account cannot be user-scoped';
END $$;

-- 5. Two users must never share a deposit address.
DO $$
DECLARE
    u1 UUID;
    u2 UUID;
BEGIN
    SELECT id INTO u1 FROM users LIMIT 1;
    INSERT INTO users (phone) VALUES ('+2348099999999') RETURNING id INTO u2;

    INSERT INTO wallets (user_id, chain, address, derivation_path)
    VALUES (u1, 'tron', 'TSharedAddress', 'm/44''/195''/0''/0/0');
    INSERT INTO wallets (user_id, chain, address, derivation_path)
    VALUES (u2, 'tron', 'TSharedAddress', 'm/44''/195''/0''/0/1');

    RAISE EXCEPTION 'FAIL: two users shared one address';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE '  ok: address cannot be shared between users';
END $$;

-- 6. Only one sweep in flight per wallet+asset.
DO $$
DECLARE
    w UUID;
BEGIN
    SELECT id INTO w FROM wallets LIMIT 1;
    INSERT INTO sweeps (wallet_id, asset, amount, destination, status)
    VALUES (w, 'USDT', 100, 'THotWallet', 'pending');
    INSERT INTO sweeps (wallet_id, asset, amount, destination, status)
    VALUES (w, 'USDT', 100, 'THotWallet', 'pending');
    RAISE EXCEPTION 'FAIL: concurrent sweeps allowed on one wallet';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE '  ok: only one in-flight sweep per wallet+asset';
END $$;

-- 7. Zero-amount entries are meaningless and must be rejected.
DO $$
DECLARE
    jid UUID;
    aid UUID;
BEGIN
    SELECT id INTO jid FROM ledger_journals LIMIT 1;
    SELECT id INTO aid FROM ledger_accounts LIMIT 1;
    INSERT INTO ledger_entries (journal_id, account_id, asset, amount)
    VALUES (jid, aid, 'NGN', 0);
    RAISE EXCEPTION 'FAIL: zero-amount entry accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE '  ok: zero-amount entry rejected';
END $$;

-- 8. Balances read back correctly, with liabilities stored negative.
DO $$
DECLARE
    user_balance NUMERIC;
    float_balance NUMERIC;
BEGIN
    SELECT balance INTO user_balance FROM ledger_balances WHERE kind = 'user_ngn';
    SELECT balance INTO float_balance FROM ledger_balances WHERE kind = 'ngn_float';

    IF user_balance <> -1000 THEN
        RAISE EXCEPTION 'FAIL: user liability is %, expected -1000', user_balance;
    END IF;
    IF float_balance <> 1000 THEN
        RAISE EXCEPTION 'FAIL: float asset is %, expected 1000', float_balance;
    END IF;
    RAISE NOTICE '  ok: balances derive correctly (user %, float %)',
        user_balance, float_balance;
END $$;


-- 9. A credited deposit must point at the journal that credited it. Without
--    this, a crediting bug could leave a balance with no journal behind it —
--    money reconciliation could never explain.
DO $$
DECLARE
    uid UUID;
    wid UUID;
BEGIN
    SELECT id INTO uid FROM users WHERE phone = '+2348012345678';
    SELECT id INTO wid FROM wallets WHERE address = 'TSweepTestWallet';

    INSERT INTO deposits (user_id, wallet_id, chain, network, asset, tx_hash,
                          amount, block_number, status)
    VALUES (uid, wid, 'tron', 'tron', 'USDT', 'tx-confirmed-no-journal',
            10, 1, 'confirmed');
    RAISE EXCEPTION 'FAIL: deposit marked confirmed with no journal';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE '  ok: confirmed deposit without a journal rejected';
END $$;

-- 10. And a reversed one at the journal that undid it, for the same reason in
--     the other direction.
DO $$
DECLARE
    uid UUID;
    wid UUID;
    jid UUID;
BEGIN
    SELECT id INTO uid FROM users WHERE phone = '+2348012345678';
    SELECT id INTO wid FROM wallets WHERE address = 'TSweepTestWallet';
    SELECT id INTO jid FROM ledger_journals WHERE idempotency_key = 'test-key-1';

    INSERT INTO deposits (user_id, wallet_id, chain, network, asset, tx_hash,
                          amount, block_number, status, credited_journal_id)
    VALUES (uid, wid, 'tron', 'tron', 'USDT', 'tx-reversed-no-journal',
            10, 1, 'reversed', jid);
    RAISE EXCEPTION 'FAIL: deposit marked reversed with no reversing journal';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE '  ok: reversed deposit without a reversing journal rejected';
END $$;

-- 11. The watcher's whole idempotency guarantee: reprocessing a block must not
--     insert the same transfer twice.
DO $$
DECLARE
    uid UUID;
    wid UUID;
BEGIN
    SELECT id INTO uid FROM users WHERE phone = '+2348012345678';
    SELECT id INTO wid FROM wallets WHERE address = 'TSweepTestWallet';

    INSERT INTO deposits (user_id, wallet_id, chain, network, asset, tx_hash,
                          output_index, amount, block_number)
    VALUES (uid, wid, 'tron', 'tron', 'USDT', 'tx-seen-twice', 0, 10, 1);
    INSERT INTO deposits (user_id, wallet_id, chain, network, asset, tx_hash,
                          output_index, amount, block_number)
    VALUES (uid, wid, 'tron', 'tron', 'USDT', 'tx-seen-twice', 0, 10, 1);
    RAISE EXCEPTION 'FAIL: the same transfer was recorded twice';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE '  ok: the same transfer cannot be recorded twice';
END $$;

-- 12. One native-coin row per network. NULL is distinct from NULL in a plain
--     unique index, so two "native" rows would otherwise both be accepted and
--     the watcher would credit a deposit against whichever it read first.
DO $$
BEGIN
    INSERT INTO token_contracts (network, asset, contract, decimals)
    VALUES ('tron', 'TRX', NULL, 6);
    RAISE EXCEPTION 'FAIL: two native rows accepted for one network';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE '  ok: one native-coin row per network';
END $$;

\echo ''
\echo 'All schema invariants hold.'
