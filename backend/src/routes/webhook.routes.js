const express = require('express');
const router = express.Router();
const Transaction = require('../models/transaction.model');
const { verifyWebhookSignature } = require('../services/paystack.service');
const User = require('../models/user.model');
const { sendPushNotification } = require('../services/notifications.service');

// Paystack sends raw JSON body — must be parsed before this point as raw buffer
router.post('/paystack', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-paystack-signature'];

  if (!verifyWebhookSignature(req.body, signature)) {
    return res.status(401).json({ message: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).json({ message: 'Invalid JSON' });
  }

  const { event: eventType, data } = event;

  if (!['transfer.success', 'transfer.failed', 'transfer.reversed'].includes(eventType)) {
    return res.sendStatus(200); // acknowledge unrelated events
  }

  const transferCode = data?.transfer_code;
  if (!transferCode) return res.sendStatus(200);

  try {
    const transaction = await Transaction.findOne({ paystackTransferCode: transferCode });
    if (!transaction) return res.sendStatus(200); // not our transaction

    if (eventType === 'transfer.success') {
      transaction.status = 'paid';
      transaction.paidAt = new Date();
    } else {
      // transfer.failed or transfer.reversed
      transaction.status = 'rejected';
      transaction.adminNote = `Payout failed: ${data?.gateway_response || eventType}`;
    }

    await transaction.save();

    // Notify user of final status
    try {
      const txUser = await User.findById(transaction.user).select('pushToken');
      if (txUser?.pushToken) {
        if (eventType === 'transfer.success') {
          await sendPushNotification(txUser.pushToken, {
            title: '✅ Payment Sent!',
            body: `₦${Number(transaction.amountNaira || 0).toLocaleString()} has been sent to your bank account.`,
            data: { transactionId: transaction._id.toString(), type: 'transaction_update', status: 'paid' },
          });
        } else {
          await sendPushNotification(txUser.pushToken, {
            title: '⚠️ Payout Failed',
            body: `Your payout could not be processed: ${data?.gateway_response || 'Please contact support.'}`,
            data: { transactionId: transaction._id.toString(), type: 'transaction_update', status: 'rejected' },
          });
        }
      }
    } catch {}
  } catch (err) {
    console.error('Webhook handler error:', err.message);
  }

  // Always return 200 so Paystack doesn't retry
  return res.sendStatus(200);
});

module.exports = router;
