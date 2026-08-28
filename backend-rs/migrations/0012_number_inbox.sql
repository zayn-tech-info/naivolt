-- Every message a number receives, not just the first.
--
-- `number_orders.sms_code` holds one code because that is all the buy flow
-- needed: get the code, done. But a number is live for twenty minutes and can
-- receive several messages in that window — a second attempt after the first
-- code expired, a follow-up from the same service, a message from a different
-- sender entirely. Keeping only the first meant the rest arrived, were paid
-- for, and were thrown away.
--
-- `sms_code` stays where it is. It is what the order was fulfilled on and what
-- the ledger settled against; this table is the record beside it.

CREATE TABLE number_messages (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id    UUID NOT NULL REFERENCES number_orders(id) ON DELETE CASCADE,
    -- Who sent it, when the supplier says so. Both optional: 5SIM omits the
    -- sender on some routes and the timestamp on others.
    sender      TEXT,
    text        TEXT NOT NULL,
    -- The digits the supplier extracted. Null when it could not find any, in
    -- which case the text is all the user has to go on.
    code        TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- The supplier gives messages no id, so the text is the identity. Polling
    -- happens every few seconds while a number is live, and without this each
    -- poll would insert the same message again. Two genuinely identical texts
    -- on one order collapse into one row — a worse outcome than an inbox that
    -- grows a duplicate every five seconds.
    UNIQUE (order_id, text)
);

CREATE INDEX number_messages_by_order ON number_messages (order_id, received_at DESC);
