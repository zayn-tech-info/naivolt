\set ON_ERROR_STOP on

BEGIN;

INSERT INTO users (email) VALUES ('number-order-invariants@example.test');
INSERT INTO ledger_journals (kind, reference, idempotency_key) VALUES
    ('number_reserve', 'number-test-reserve-1', 'number-test-reserve-1'),
    ('number_reserve', 'number-test-reserve-2', 'number-test-reserve-2'),
    ('number_settle', 'number-test-settle', 'number-test-settle'),
    ('number_refund', 'number-test-refund', 'number-test-refund');

INSERT INTO number_orders (
    user_id, product_id, country_id, price_ngn, status, reference,
    reserved_journal_id, idempotency_key, idempotency_payload_complete
)
SELECT u.id, p.id, c.id, 500, 'reserved', 'NVNO-INVARIANT-1',
       reserve.id, '00000000-0000-4000-8000-000000000001', true
  FROM users u
 CROSS JOIN LATERAL (SELECT id FROM number_products ORDER BY id LIMIT 1) p
 CROSS JOIN LATERAL (SELECT id FROM number_countries ORDER BY id LIMIT 1) c
 JOIN ledger_journals reserve ON reserve.reference = 'number-test-reserve-1'
 WHERE u.email = 'number-order-invariants@example.test';

DO $$
BEGIN
    UPDATE number_orders SET status = 'mystery' WHERE reference = 'NVNO-INVARIANT-1';
    RAISE EXCEPTION 'FAIL: unknown status accepted';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '  ok: unknown status rejected';
END $$;

DO $$
BEGIN
    UPDATE number_orders SET status = 'review_required' WHERE reference = 'NVNO-INVARIANT-1';
    RAISE EXCEPTION 'FAIL: review state without reason and timestamp accepted';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '  ok: review state needs safe reason and timestamp';
END $$;

UPDATE number_orders
   SET status = 'review_required', review_required_at = now(), review_reason = 'purchase_outcome_unknown'
 WHERE reference = 'NVNO-INVARIANT-1';

DO $$
BEGIN
    UPDATE number_orders SET reconcile_claim_token = gen_random_uuid() WHERE reference = 'NVNO-INVARIANT-1';
    RAISE EXCEPTION 'FAIL: partial reconciliation claim accepted';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '  ok: reconciliation claim token and lease are paired';
END $$;

DO $$
DECLARE slot_count INTEGER;
BEGIN
    SELECT count(*) INTO slot_count FROM number_provider_slots;
    IF slot_count <> 10 THEN RAISE EXCEPTION 'FAIL: expected ten provider slots, got %', slot_count; END IF;
    RAISE NOTICE '  ok: ten provider slots are seeded';
END $$;

INSERT INTO operator_alerts(number_order_id, dedupe_key)
SELECT id, 'number-review:' || id FROM number_orders WHERE reference = 'NVNO-INVARIANT-1';
DO $$
BEGIN
    INSERT INTO operator_alerts(number_order_id, dedupe_key)
    SELECT id, 'number-review:' || id FROM number_orders WHERE reference = 'NVNO-INVARIANT-1';
    RAISE EXCEPTION 'FAIL: duplicate operator alert accepted';
EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE '  ok: operator review alerts are deduplicated';
END $$;

DO $$
BEGIN
    UPDATE number_orders SET status = 'delivered' WHERE reference = 'NVNO-INVARIANT-1';
    RAISE EXCEPTION 'FAIL: delivery without settlement accepted';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '  ok: delivery needs settlement journal';
END $$;

DO $$
BEGIN
    UPDATE number_orders
       SET status = 'cancelled',
           refunded_journal_id = (SELECT id FROM ledger_journals WHERE reference = 'number-test-refund'),
           failure_reason = ''
     WHERE reference = 'NVNO-INVARIANT-1';
    RAISE EXCEPTION 'FAIL: empty refund reason accepted';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '  ok: refund terminal state needs a reason';
END $$;

DO $$
BEGIN
    INSERT INTO number_orders (
        user_id, product_id, country_id, price_ngn, status, reference,
        reserved_journal_id, idempotency_key, idempotency_payload_complete
    )
    SELECT user_id, product_id, country_id, price_ngn, 'reserved', 'NVNO-INVARIANT-2',
           reserved_journal_id, '00000000-0000-4000-8000-000000000002', true
      FROM number_orders WHERE reference = 'NVNO-INVARIANT-1';
    RAISE EXCEPTION 'FAIL: duplicate reservation journal accepted';
EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE '  ok: reservation journal belongs to one order';
END $$;

ROLLBACK;

\echo 'All number order invariants hold.'
