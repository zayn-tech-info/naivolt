-- A name the user chooses for themselves.
--
-- Distinct from the legal name on `kyc_verifications.full_name`, and the two
-- must not be conflated: one is what we greet them with, the other is what a
-- bank account has to match at payout. Letting a display name edit overwrite a
-- verified legal name would quietly break that match.
ALTER TABLE users ADD COLUMN display_name TEXT;

-- Avatars are generated from a per-user seed rather than uploaded. No image
-- hosting, no moderation surface, no upload to fail on a bad connection — and
-- it is stable, so the same person looks the same on every device.
--
-- Stored rather than derived from the id so a user can shuffle it, and so the
-- rendering rule can change without every avatar changing with it.
ALTER TABLE users ADD COLUMN avatar_seed TEXT;
