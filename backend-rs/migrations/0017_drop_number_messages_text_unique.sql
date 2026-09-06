-- Two genuine supplier messages can share the same text (retries, resends).
-- Identity is `provider_message_key` from migration 0016. The old UNIQUE
-- (order_id, text) made a second distinct timestamp fail the insert and
-- rolled back the whole settlement transaction, leaving the order awaiting
-- a code that had already arrived.
ALTER TABLE number_messages DROP CONSTRAINT IF EXISTS number_messages_order_id_text_key;
