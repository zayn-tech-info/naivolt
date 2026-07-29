-- Auth schema invariants. Requires 0001 and 0002 applied.
\set ON_ERROR_STOP on

BEGIN;
INSERT INTO users (email) VALUES ('ada@example.com');
INSERT INTO identities (user_id, provider, subject, email, verified_at)
SELECT id, 'google', 'google-sub-1', 'ada@example.com', now()
  FROM users WHERE email = 'ada@example.com';
COMMIT;

\echo '  ok: google signup creates user + identity'

-- 1. One provider account cannot map to two users.
DO $$
DECLARE u2 UUID;
BEGIN
    INSERT INTO users (email) VALUES ('mallory@example.com') RETURNING id INTO u2;
    INSERT INTO identities (user_id, provider, subject, email, verified_at)
    VALUES (u2, 'google', 'google-sub-1', 'mallory@example.com', now());
    RAISE EXCEPTION 'FAIL: one google account claimed by two users';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE '  ok: provider subject is unique across users';
END $$;

-- 2. A user linking phone to an existing Google account stays one user.
DO $$
DECLARE u UUID; n INT;
BEGIN
    SELECT id INTO u FROM users WHERE email = 'ada@example.com';
    INSERT INTO identities (user_id, provider, subject, phone, verified_at)
    VALUES (u, 'phone', '+2348012345678', '+2348012345678', now());

    SELECT count(*) INTO n FROM identities WHERE user_id = u;
    IF n <> 2 THEN RAISE EXCEPTION 'FAIL: expected 2 identities, got %', n; END IF;
    RAISE NOTICE '  ok: second sign-in method links to the same user (% identities)', n;
END $$;

-- 3. The last identity cannot be removed.
DO $$
DECLARE u UUID;
BEGIN
    -- Ada has two, so removing one is fine.
    SELECT id INTO u FROM users WHERE email = 'ada@example.com';
    DELETE FROM identities WHERE user_id = u AND provider = 'phone';
    RAISE NOTICE '  ok: non-final identity can be unlinked';

    -- Removing the remaining one must fail.
    BEGIN
        DELETE FROM identities WHERE user_id = u;
        RAISE EXCEPTION 'FAIL: last identity was removed, orphaning the account';
    EXCEPTION
        WHEN raise_exception THEN
            IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF;
            RAISE NOTICE '  ok: last identity cannot be unlinked';
    END;
END $$;

-- 4. Only one live OTP challenge per destination.
DO $$
BEGIN
    INSERT INTO otp_challenges (destination, code_hash, expires_at)
    VALUES ('+2348099999999', '$argon2id$fake', now() + interval '10 min');
    INSERT INTO otp_challenges (destination, code_hash, expires_at)
    VALUES ('+2348099999999', '$argon2id$fake2', now() + interval '10 min');
    RAISE EXCEPTION 'FAIL: two live OTP codes for one number';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE '  ok: only one live OTP per destination';
END $$;

-- 5. KYC tier cannot be raised without an approved verification.
DO $$
DECLARE u UUID;
BEGIN
    SELECT id INTO u FROM users WHERE email = 'ada@example.com';
    UPDATE users SET kyc_tier = 2 WHERE id = u;
    RAISE EXCEPTION 'FAIL: tier raised with no approved verification';
EXCEPTION
    WHEN raise_exception THEN
        IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF;
        RAISE NOTICE '  ok: kyc_tier cannot be raised without approval';
END $$;

-- 6. With an approved verification, the tier can be raised.
DO $$
DECLARE u UUID; t SMALLINT;
BEGIN
    SELECT id INTO u FROM users WHERE email = 'ada@example.com';
    INSERT INTO kyc_verifications
        (user_id, target_tier, provider, status, bvn_last4, full_name)
    VALUES (u, 1, 'dojah', 'approved', '4321', 'Ada Lovelace');

    UPDATE users SET kyc_tier = 1 WHERE id = u;
    SELECT kyc_tier INTO t FROM users WHERE id = u;
    IF t <> 1 THEN RAISE EXCEPTION 'FAIL: tier not applied'; END IF;
    RAISE NOTICE '  ok: approved verification raises the tier';
END $$;

-- 7. Full BVN must never be storable — only the last 4.
DO $$
DECLARE u UUID;
BEGIN
    SELECT id INTO u FROM users WHERE email = 'ada@example.com';
    INSERT INTO kyc_verifications (user_id, target_tier, provider, bvn_last4)
    VALUES (u, 3, 'dojah', '22334455667');
    RAISE EXCEPTION 'FAIL: full BVN was stored';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE '  ok: only the last 4 BVN digits fit the column';
END $$;

-- 8. A user must always have some contact method.
DO $$
BEGIN
    INSERT INTO users DEFAULT VALUES;
    RAISE EXCEPTION 'FAIL: user created with no phone and no email';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE '  ok: user needs a phone or an email';
END $$;

-- 9. Address index is assigned automatically, uniquely, and in range.
DO $$
DECLARE a BIGINT; b BIGINT;
BEGIN
    INSERT INTO users (phone) VALUES ('+2348055555555') RETURNING address_index INTO a;
    INSERT INTO users (phone) VALUES ('+2348066666666') RETURNING address_index INTO b;
    IF a = b THEN RAISE EXCEPTION 'FAIL: duplicate address_index'; END IF;
    IF b >= 2147483648 THEN RAISE EXCEPTION 'FAIL: index out of BIP-32 range'; END IF;
    RAISE NOTICE '  ok: address_index auto-assigned and distinct (%, %)', a, b;
END $$;

\echo ''
\echo 'All auth invariants hold.'
