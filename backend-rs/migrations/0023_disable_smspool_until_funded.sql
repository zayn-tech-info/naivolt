-- SMSPool is not funded. Keep 5SIM as the only listed source so the shop
-- cannot sell numbers we cannot buy. Operators can turn SMSPool on later.
UPDATE number_sell_settings
   SET fivesim_enabled = true,
       smspool_enabled = false,
       updated_at = now()
 WHERE id = 1;
