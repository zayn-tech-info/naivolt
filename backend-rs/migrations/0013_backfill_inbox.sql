-- Give already-delivered orders their message.
--
-- 0012 added the inbox, but only orders advanced *after* it record into the
-- table. Everything bought before shows a code on the order row and an empty
-- inbox on its page, which reads as a bug rather than as history.
--
-- The supplier is not re-asked: a delivered order's number is long released, and
-- 5SIM keeps nothing to re-read. What we have is what we stored, so that is what
-- is copied across.
INSERT INTO number_messages (order_id, sender, text, code, received_at)
SELECT o.id,
       NULL,
       COALESCE(NULLIF(o.sms_text, ''), o.sms_code),
       o.sms_code,
       -- No arrival time was ever recorded; the order's own timestamp is the
       -- closest honest answer.
       COALESCE(o.updated_at, o.created_at)
  FROM number_orders o
 WHERE o.sms_code IS NOT NULL
   AND COALESCE(NULLIF(o.sms_text, ''), o.sms_code) IS NOT NULL
ON CONFLICT (order_id, text) DO NOTHING;
