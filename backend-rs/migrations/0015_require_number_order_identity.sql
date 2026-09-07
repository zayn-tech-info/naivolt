UPDATE number_orders o
   SET idempotency_key = j.idempotency_key::UUID
  FROM ledger_journals j
 WHERE o.idempotency_key IS NULL
   AND j.id = o.reserved_journal_id
   AND j.idempotency_key ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

DO $$
DECLARE
    missing_keys BIGINT;
    missing_reservations BIGINT;
BEGIN
    SELECT count(*) INTO missing_keys FROM number_orders WHERE idempotency_key IS NULL;
    SELECT count(*) INTO missing_reservations FROM number_orders WHERE reserved_journal_id IS NULL;

    IF missing_keys > 0 OR missing_reservations > 0 THEN
        RAISE EXCEPTION
            'number order closing migration blocked: missing keys=%, missing reservation journals=%',
            missing_keys, missing_reservations;
    END IF;
END $$;

ALTER TABLE number_orders
    ALTER COLUMN idempotency_key SET NOT NULL,
    ALTER COLUMN reserved_journal_id SET NOT NULL;
