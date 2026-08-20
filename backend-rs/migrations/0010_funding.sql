-- Funding a naira balance.
--
-- The mirror of a payout: money arrives from outside instead of leaving. What
-- makes it different is who moves first — the user's card is charged by someone
-- else's system, so we cannot reserve anything up front. Naira is credited only
-- once the provider confirms the charge succeeded, never on intent.
--
-- Crediting on intent would mean funding an account from a card that later
-- declines, and a user who has already spent the balance by the time it does.
-- So an intent is a row with no ledger entry; the credit is a second step that
-- happens exactly once, keyed on the provider's own reference.

CREATE TABLE ngn_deposits (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id),
    amount_ngn          NUMERIC(20, 4) NOT NULL CHECK (amount_ngn > 0),

    provider            TEXT NOT NULL,
    -- Ours, sent to the provider and echoed back. UNIQUE so a replayed webhook
    -- or a double verify can never credit the same charge twice.
    provider_reference  TEXT NOT NULL UNIQUE,

    -- pending -> succeeded | failed | abandoned
    status              TEXT NOT NULL DEFAULT 'pending',
    -- Set only on a successful credit. Its presence *is* the record that the
    -- money landed in the ledger, so it is what makes crediting idempotent.
    credited_journal_id UUID REFERENCES ledger_journals(id),
    failure_reason      TEXT,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT credited_deposits_are_succeeded CHECK (
        credited_journal_id IS NULL OR status = 'succeeded'
    )
);

CREATE INDEX ngn_deposits_user ON ngn_deposits (user_id, created_at DESC);
CREATE INDEX ngn_deposits_pending ON ngn_deposits (status, created_at)
    WHERE status = 'pending';
