-- Who Naivolt currently sells numbers from.
-- Customers never see these flags; list and buy read them to filter sources.

CREATE TABLE number_sell_settings (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    fivesim_enabled BOOLEAN NOT NULL,
    smspool_enabled BOOLEAN NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT number_sell_settings_one_on CHECK (fivesim_enabled OR smspool_enabled)
);

INSERT INTO number_sell_settings (id, fivesim_enabled, smspool_enabled)
VALUES (1, true, false);
