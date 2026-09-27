-- Extra operations accounts, invited from the dashboard.
-- ADMIN_EMAILS stays the bootstrap owner; adding a teammate does not need a
-- VPS env edit. A row is an allowlist entry, not an authenticator: the invitee
-- still enrols TOTP on first sign-in.

CREATE TABLE admin_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL UNIQUE,
    invited_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ
);
