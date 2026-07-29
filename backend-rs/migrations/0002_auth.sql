-- Auth: OIDC identities, phone OTP, sessions, KYC.
--
-- Signup is frictionless (§10) and KYC is enforced at withdrawal, not at the
-- door (§10.3). users.kyc_tier stays 0 until a verification is approved.

-- ---------------------------------------------------------------------------
-- Identities — one user, many ways to sign in (§10.1)
-- ---------------------------------------------------------------------------

CREATE TABLE identities (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider    TEXT NOT NULL CHECK (provider IN ('google', 'apple', 'phone')),
    -- Google/Apple `sub`, or the E.164 phone number.
    subject     TEXT NOT NULL,
    -- Contact details as attested by this provider. NULL when not attested:
    -- a Google token with email_verified=false stores NULL here, never the
    -- address, so it can never be matched against during account linking.
    email       TEXT,
    phone       TEXT,
    verified_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- One provider account maps to exactly one user, forever.
    UNIQUE (provider, subject)
);

CREATE INDEX identities_by_user ON identities (user_id);

-- Linking lookups only ever consider *verified* rows. These partial indexes make
-- that the fast path and the obvious one to query.
CREATE INDEX identities_verified_email ON identities (email)
    WHERE email IS NOT NULL AND verified_at IS NOT NULL;
CREATE INDEX identities_verified_phone ON identities (phone)
    WHERE phone IS NOT NULL AND verified_at IS NOT NULL;

-- Every user must keep at least one way in. Enforced as a trigger because a
-- constraint cannot span rows; deleting the last identity would orphan the
-- account and the funds in it.
CREATE OR REPLACE FUNCTION assert_user_keeps_an_identity() RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM identities WHERE user_id = OLD.user_id AND id <> OLD.id
    ) AND EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id) THEN
        RAISE EXCEPTION
            'cannot remove the last identity for user % — the account would be unreachable',
            OLD.user_id;
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER identities_keep_at_least_one
    BEFORE DELETE ON identities
    FOR EACH ROW EXECUTE FUNCTION assert_user_keeps_an_identity();

-- ---------------------------------------------------------------------------
-- OTP challenges
-- ---------------------------------------------------------------------------

CREATE TABLE otp_challenges (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- E.164 phone. Not a user reference: a challenge is issued before we know
    -- whether this is a signup or a login.
    destination  TEXT NOT NULL,
    -- Argon2. A database leak must not yield live codes.
    code_hash    TEXT NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    expires_at   TIMESTAMPTZ NOT NULL,
    consumed_at  TIMESTAMPTZ,
    last_sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip           INET,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one live challenge per destination, so a flood of requests cannot
-- create a pile of simultaneously-valid codes.
CREATE UNIQUE INDEX otp_one_live_per_destination
    ON otp_challenges (destination) WHERE consumed_at IS NULL;

CREATE INDEX otp_expiry_sweep ON otp_challenges (expires_at) WHERE consumed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Sessions — rotating refresh tokens with reuse detection
-- ---------------------------------------------------------------------------

CREATE TABLE sessions (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- All rotations of one login share a family id. Presenting an already-used
    -- token means it was stolen, so the whole family is revoked at once.
    family_id         UUID NOT NULL,
    -- SHA-256 of the refresh token. The raw token exists only on the device.
    refresh_token_hash TEXT NOT NULL UNIQUE,
    device_id         TEXT,
    device_name       TEXT,
    ip                INET,
    expires_at        TIMESTAMPTZ NOT NULL,
    -- Set when this token is exchanged. A second exchange is theft.
    rotated_at        TIMESTAMPTZ,
    revoked_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sessions_by_user ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_family ON sessions (family_id);

-- ---------------------------------------------------------------------------
-- KYC
-- ---------------------------------------------------------------------------

CREATE TABLE kyc_verifications (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            UUID NOT NULL REFERENCES users(id),
    target_tier        SMALLINT NOT NULL CHECK (target_tier BETWEEN 1 AND 3),
    provider           TEXT NOT NULL,          -- dojah | smileid | paystack
    provider_reference TEXT,
    -- pending -> approved | rejected | manual_review
    status             TEXT NOT NULL DEFAULT 'pending',
    -- Only the last 4 digits are retained. Storing full BVN/NIN turns a database
    -- breach into an identity-theft incident; the provider holds the record and
    -- we keep just enough to display and reconcile.
    bvn_last4          TEXT CHECK (bvn_last4 ~ '^[0-9]{4}$'),
    nin_last4          TEXT CHECK (nin_last4 ~ '^[0-9]{4}$'),
    -- The name the payout account must match against.
    full_name          TEXT,
    date_of_birth      DATE,
    rejection_reason   TEXT,
    reviewed_by        UUID,
    reviewed_at        TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX kyc_by_user ON kyc_verifications (user_id, created_at DESC);
CREATE INDEX kyc_review_queue ON kyc_verifications (status, created_at)
    WHERE status IN ('pending', 'manual_review');

-- One in-flight submission per user per tier: re-submitting should update, not
-- stack up duplicates in the review queue.
CREATE UNIQUE INDEX kyc_one_pending_per_tier
    ON kyc_verifications (user_id, target_tier)
    WHERE status IN ('pending', 'manual_review');

-- A tier is only ever granted by an approved verification. Guards against an
-- admin bumping kyc_tier directly and quietly lifting someone's payout cap.
CREATE OR REPLACE FUNCTION assert_tier_is_earned() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.kyc_tier > OLD.kyc_tier THEN
        IF NOT EXISTS (
            SELECT 1 FROM kyc_verifications
             WHERE user_id = NEW.id
               AND target_tier >= NEW.kyc_tier
               AND status = 'approved'
        ) THEN
            RAISE EXCEPTION
                'cannot raise user % to tier % without an approved verification',
                NEW.id, NEW.kyc_tier;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_tier_must_be_earned
    BEFORE UPDATE OF kyc_tier ON users
    FOR EACH ROW EXECUTE FUNCTION assert_tier_is_earned();

-- Rolling 24h payout usage, for the tier cap check.
CREATE VIEW payout_usage_24h AS
SELECT user_id, COALESCE(SUM(amount_ngn), 0) AS used_ngn
  FROM payouts
 WHERE created_at > now() - INTERVAL '24 hours'
   AND status IN ('reserved', 'processing', 'settled')
 GROUP BY user_id;
