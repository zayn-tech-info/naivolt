ALTER TABLE number_orders
    ADD COLUMN idempotency_key UUID,
    ADD COLUMN expected_price_ngn NUMERIC(20, 4),
    ADD COLUMN idempotency_payload_complete BOOLEAN NOT NULL DEFAULT false;

DO $$
DECLARE
    missing_reservations BIGINT;
    malformed_keys BIGINT;
    unknown_statuses BIGINT;
    invalid_open BIGINT;
    invalid_delivered BIGINT;
    invalid_refunded BIGINT;
BEGIN
    SELECT count(*) INTO missing_reservations FROM number_orders WHERE reserved_journal_id IS NULL;
    SELECT count(*) INTO malformed_keys
      FROM number_orders o
      JOIN ledger_journals j ON j.id = o.reserved_journal_id
     WHERE j.idempotency_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    SELECT count(*) INTO unknown_statuses
      FROM number_orders
     WHERE status NOT IN ('reserved', 'awaiting_code', 'delivered', 'expired', 'cancelled', 'failed');
    SELECT count(*) INTO invalid_open
      FROM number_orders
     WHERE status IN ('reserved', 'awaiting_code')
       AND (settled_journal_id IS NOT NULL OR refunded_journal_id IS NOT NULL OR failure_reason IS NOT NULL);
    SELECT count(*) INTO invalid_delivered
      FROM number_orders
     WHERE status = 'delivered'
       AND (settled_journal_id IS NULL OR refunded_journal_id IS NOT NULL OR failure_reason IS NOT NULL);
    SELECT count(*) INTO invalid_refunded
      FROM number_orders
     WHERE status IN ('expired', 'cancelled', 'failed')
       AND (settled_journal_id IS NOT NULL OR refunded_journal_id IS NULL
            OR failure_reason IS NULL OR length(btrim(failure_reason)) = 0);

    IF missing_reservations > 0 OR malformed_keys > 0 OR unknown_statuses > 0
       OR invalid_open > 0 OR invalid_delivered > 0 OR invalid_refunded > 0 THEN
        RAISE EXCEPTION
            'number order migration blocked: missing reservation journals=%, malformed UUID keys=%, unknown statuses=%, invalid open=%, invalid delivered=%, invalid refunded=%',
            missing_reservations, malformed_keys, unknown_statuses, invalid_open,
            invalid_delivered, invalid_refunded;
    END IF;
END $$;

UPDATE number_orders o
   SET idempotency_key = j.idempotency_key::UUID
  FROM ledger_journals j
 WHERE j.id = o.reserved_journal_id;

CREATE UNIQUE INDEX number_orders_user_idempotency_unique
    ON number_orders (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX number_orders_reserved_journal_unique
    ON number_orders (reserved_journal_id) WHERE reserved_journal_id IS NOT NULL;
CREATE UNIQUE INDEX number_orders_settled_journal_unique
    ON number_orders (settled_journal_id) WHERE settled_journal_id IS NOT NULL;
CREATE UNIQUE INDEX number_orders_refunded_journal_unique
    ON number_orders (refunded_journal_id) WHERE refunded_journal_id IS NOT NULL;

ALTER TABLE number_orders
    ADD CONSTRAINT number_orders_status_allowed CHECK (
        status IN ('reserved', 'awaiting_code', 'delivered', 'expired', 'cancelled', 'failed')
    ),
    ADD CONSTRAINT number_orders_financial_state_valid CHECK (
        (status IN ('reserved', 'awaiting_code')
            AND settled_journal_id IS NULL
            AND refunded_journal_id IS NULL
            AND failure_reason IS NULL)
        OR (status = 'delivered'
            AND settled_journal_id IS NOT NULL
            AND refunded_journal_id IS NULL
            AND failure_reason IS NULL)
        OR (status IN ('expired', 'cancelled', 'failed')
            AND settled_journal_id IS NULL
            AND refunded_journal_id IS NOT NULL
            AND failure_reason IS NOT NULL
            AND length(btrim(failure_reason)) > 0)
    );
