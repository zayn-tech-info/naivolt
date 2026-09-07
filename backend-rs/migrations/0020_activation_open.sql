-- Provider lifetime is separate from money status. True only while the
-- supplier still says the activation can receive SMS.
ALTER TABLE number_orders
    ADD COLUMN activation_open BOOLEAN NOT NULL DEFAULT false;

UPDATE number_orders
   SET activation_open = true
 WHERE status = 'awaiting_code'
   AND provider_order_id IS NOT NULL
   AND (expires_at IS NULL OR expires_at > now());

DROP INDEX IF EXISTS number_orders_reconcile_due_idx;
CREATE INDEX number_orders_reconcile_due_idx ON number_orders (reconcile_next_at)
    WHERE reconciliation_payload_complete
      AND (
            status IN ('reserved', 'awaiting_code')
         OR (status = 'delivered' AND activation_open)
      );
