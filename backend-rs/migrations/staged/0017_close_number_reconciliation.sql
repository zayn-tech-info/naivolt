INSERT INTO operator_alerts (number_order_id, dedupe_key)
SELECT id, 'number-review:' || id
  FROM number_orders
 WHERE NOT reconciliation_payload_complete
   AND status IN ('reserved', 'awaiting_code')
   AND provider_order_id IS NULL
ON CONFLICT (dedupe_key) DO NOTHING;

UPDATE number_orders
   SET status = 'review_required',
       review_required_at = now(),
       review_reason = 'legacy_purchase_outcome_unknown',
       reconciliation_payload_complete = true,
       reconcile_next_at = NULL,
       reconcile_claim_token = NULL,
       reconcile_claimed_until = NULL,
       updated_at = now()
 WHERE NOT reconciliation_payload_complete
   AND status IN ('reserved', 'awaiting_code')
   AND provider_order_id IS NULL;

WITH known AS (
    SELECT id, row_number() OVER (ORDER BY created_at, id) - 1 AS ordinal
      FROM number_orders
     WHERE NOT reconciliation_payload_complete
       AND status IN ('reserved', 'awaiting_code')
       AND provider_order_id IS NOT NULL
)
UPDATE number_orders o
   SET reconciliation_payload_complete = true,
       status = 'awaiting_code',
       reconcile_next_at = now() + ((known.ordinal % 60) * interval '1 second'),
       updated_at = now()
  FROM known WHERE known.id = o.id;

UPDATE number_orders
   SET reconciliation_payload_complete = true
 WHERE NOT reconciliation_payload_complete
   AND status IN ('delivered', 'expired', 'cancelled', 'failed', 'review_required');

UPDATE number_messages m
   SET provider_message_key = encode(digest(jsonb_build_array(
       o.provider_order_id, m.sender, m.text, m.code, m.received_at)::text, 'sha256'), 'hex')
  FROM number_orders o
 WHERE o.id = m.order_id AND m.provider_message_key IS NULL;

ALTER TABLE number_messages DROP CONSTRAINT number_messages_order_id_text_key;
ALTER TABLE number_messages ALTER COLUMN provider_message_key SET NOT NULL;
