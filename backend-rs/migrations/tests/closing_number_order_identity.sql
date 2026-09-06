\set ON_ERROR_STOP on

BEGIN;

INSERT INTO users (email) VALUES ('closing-order-identity@example.test');
INSERT INTO ledger_journals (kind, reference, idempotency_key)
VALUES (
    'number_reserve',
    'closing-order-reservation',
    '00000000-0000-4000-8000-000000000015'
);

INSERT INTO number_orders (
    user_id, product_id, country_id, price_ngn, status, reference,
    reserved_journal_id, idempotency_payload_complete
)
SELECT u.id, p.id, c.id, 500, 'reserved', 'NVNO-CLOSING-OVERLAP', j.id, false
  FROM users u
 CROSS JOIN LATERAL (SELECT id FROM number_products ORDER BY id LIMIT 1) p
 CROSS JOIN LATERAL (SELECT id FROM number_countries ORDER BY id LIMIT 1) c
  JOIN ledger_journals j ON j.reference = 'closing-order-reservation'
 WHERE u.email = 'closing-order-identity@example.test';

\ir ../staged/0015_require_number_order_identity.sql

DO $$
DECLARE
    stored_key UUID;
    required_columns BIGINT;
BEGIN
    SELECT idempotency_key INTO stored_key
      FROM number_orders
     WHERE reference = 'NVNO-CLOSING-OVERLAP';
    IF stored_key <> '00000000-0000-4000-8000-000000000015'::UUID THEN
        RAISE EXCEPTION 'FAIL: overlap order key was not backfilled';
    END IF;

    SELECT count(*) INTO required_columns
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'number_orders'
       AND column_name IN ('idempotency_key', 'reserved_journal_id')
       AND is_nullable = 'NO';
    IF required_columns <> 2 THEN
        RAISE EXCEPTION 'FAIL: closing order identity columns remain nullable';
    END IF;
END $$;

ROLLBACK;

\echo 'Closing number order identity migration holds.'
