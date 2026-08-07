-- Date of birth on the user, not only on a verification attempt.
--
-- It was being collected inside the KYC form and written to
-- `kyc_verifications`, which meant a user who had verified once still had to
-- retype it for the next tier, and the profile could not show what we held.
-- It belongs to the person, not to one submission.
ALTER TABLE users ADD COLUMN date_of_birth DATE;

-- Email is already on `users` and already UNIQUE, so a second account cannot
-- claim one that is taken — the API surfaces that as a conflict rather than a
-- 500 from the constraint.
