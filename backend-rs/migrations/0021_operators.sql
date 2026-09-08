-- Named operators who may recheck and refund held number orders.
-- Separate from customer users so a wallet login cannot become a refund login.

CREATE TABLE operators (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL UNIQUE,
    totp_secret BYTEA NOT NULL,
    disabled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE operator_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id UUID NOT NULL REFERENCES operators(id),
    token_hash BYTEA NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip INET
);

CREATE INDEX operator_sessions_operator ON operator_sessions (operator_id);
CREATE INDEX operator_sessions_expires ON operator_sessions (expires_at);
