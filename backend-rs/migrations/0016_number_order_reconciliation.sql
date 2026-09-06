ALTER TABLE number_orders
    ADD COLUMN provider_purchase_started_at TIMESTAMPTZ,
    ADD COLUMN reconcile_next_at TIMESTAMPTZ,
    ADD COLUMN reconcile_last_checked_at TIMESTAMPTZ,
    ADD COLUMN reconcile_attempt_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN reconcile_last_error_category TEXT,
    ADD COLUMN reconcile_claim_token UUID,
    ADD COLUMN reconcile_claimed_until TIMESTAMPTZ,
    ADD COLUMN review_required_at TIMESTAMPTZ,
    ADD COLUMN review_reason TEXT,
    ADD COLUMN reconciliation_payload_complete BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE number_orders
    DROP CONSTRAINT number_orders_status_allowed,
    DROP CONSTRAINT number_orders_financial_state_valid,
    ADD CONSTRAINT number_orders_status_allowed CHECK (
        status IN ('reserved', 'awaiting_code', 'delivered', 'expired', 'cancelled', 'failed', 'review_required')
    ),
    ADD CONSTRAINT number_orders_financial_state_valid CHECK (
        (status IN ('reserved', 'awaiting_code') AND settled_journal_id IS NULL AND refunded_journal_id IS NULL AND failure_reason IS NULL)
        OR (status = 'review_required' AND settled_journal_id IS NULL AND refunded_journal_id IS NULL
            AND review_required_at IS NOT NULL AND review_reason IS NOT NULL AND length(btrim(review_reason)) > 0)
        OR (status = 'delivered' AND settled_journal_id IS NOT NULL AND refunded_journal_id IS NULL AND failure_reason IS NULL)
        OR (status IN ('expired', 'cancelled', 'failed') AND settled_journal_id IS NULL AND refunded_journal_id IS NOT NULL
            AND failure_reason IS NOT NULL AND length(btrim(failure_reason)) > 0)
    ),
    ADD CONSTRAINT number_orders_reconcile_attempt_nonnegative CHECK (reconcile_attempt_count >= 0),
    ADD CONSTRAINT number_orders_reconcile_claim_pair CHECK ((reconcile_claim_token IS NULL) = (reconcile_claimed_until IS NULL)),
    ADD CONSTRAINT number_orders_reconcile_error_bounded CHECK (reconcile_last_error_category IS NULL OR length(reconcile_last_error_category) <= 64),
    ADD CONSTRAINT number_orders_review_reason_bounded CHECK (review_reason IS NULL OR length(review_reason) <= 64);

CREATE INDEX number_orders_reconcile_due_idx ON number_orders (reconcile_next_at)
    WHERE reconciliation_payload_complete AND status IN ('reserved', 'awaiting_code');

ALTER TABLE number_messages ADD COLUMN provider_message_key TEXT;
UPDATE number_messages m
   SET provider_message_key = encode(digest(jsonb_build_array(
       o.provider_order_id, m.sender, m.text, m.code, m.received_at)::text, 'sha256'), 'hex')
  FROM number_orders o WHERE o.id = m.order_id;
CREATE UNIQUE INDEX number_messages_provider_key_unique
    ON number_messages (order_id, provider_message_key) WHERE provider_message_key IS NOT NULL;

CREATE TABLE operator_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    number_order_id UUID NOT NULL REFERENCES number_orders(id),
    dedupe_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error_category TEXT CHECK (last_error_category IS NULL OR length(last_error_category) <= 64),
    claim_token UUID,
    claimed_until TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((claim_token IS NULL) = (claimed_until IS NULL))
);
CREATE INDEX operator_alerts_due_idx ON operator_alerts (next_attempt_at) WHERE state = 'pending';

CREATE TABLE number_provider_slots (
    slot SMALLINT PRIMARY KEY CHECK (slot BETWEEN 1 AND 10),
    claim_token UUID,
    claimed_until TIMESTAMPTZ,
    CHECK ((claim_token IS NULL) = (claimed_until IS NULL))
);
INSERT INTO number_provider_slots (slot) SELECT generate_series(1, 10);
