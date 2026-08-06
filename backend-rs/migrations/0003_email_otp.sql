-- Phone + email OTP; OAuth removed.
--
-- The provider set was { google, apple, phone }. It is now { phone, email }:
-- both are OTP channels and there is no OAuth anywhere in the system.
--
-- Safe to apply to an existing database only because no OAuth identity has ever
-- been written — this ships before the API serves its first request. If that
-- stops being true, this needs a data migration rather than a constraint swap.

ALTER TABLE identities DROP CONSTRAINT IF EXISTS identities_provider_check;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM identities WHERE provider IN ('google', 'apple')) THEN
        RAISE EXCEPTION
            'OAuth identities exist; this migration would orphan them. Migrate them to email identities first.';
    END IF;
END $$;

ALTER TABLE identities
    ADD CONSTRAINT identities_provider_check CHECK (provider IN ('phone', 'email'));

-- Which transport carried the code. Stored rather than re-derived from the
-- destination so a resend cannot pick a different channel from the original
-- send, and so delivery failures can be attributed to a provider.
ALTER TABLE otp_challenges
    ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'sms'
        CHECK (channel IN ('sms', 'email'));

ALTER TABLE otp_challenges ALTER COLUMN channel DROP DEFAULT;

-- An email destination must be sent by email and a phone by SMS. Enforced here
-- because the consequence of a mismatch is a code delivered nowhere and a user
-- who cannot sign in at all.
ALTER TABLE otp_challenges
    ADD CONSTRAINT otp_channel_matches_destination CHECK (
        (channel = 'email' AND destination LIKE '%@%')
        OR (channel = 'sms' AND destination LIKE '+%' AND destination NOT LIKE '%@%')
    );

-- Sessions store only a hash of the refresh token; the raw secret lives on the
-- device. Reuse detection needs the rotation timestamp to be queryable.
CREATE INDEX IF NOT EXISTS sessions_live
    ON sessions (refresh_token_hash)
    WHERE rotated_at IS NULL AND revoked_at IS NULL;
