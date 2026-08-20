-- Google sign-in, on the web.
--
-- Migration 0003 narrowed the provider set to { phone, email } when OAuth was
-- removed. This widens it again for Google only — not Apple.
--
-- That asymmetry is deliberate. Apple's App Store Guideline 4.8 requires Sign in
-- with Apple alongside any *third-party social login an app offers*. It binds
-- apps, not websites. Google on the website costs nothing; the day the Expo app
-- offers it, Apple Sign-In has to ship in the same release.

ALTER TABLE identities DROP CONSTRAINT IF EXISTS identities_provider_check;

ALTER TABLE identities
    ADD CONSTRAINT identities_provider_check CHECK (provider IN ('phone', 'email', 'google'));
