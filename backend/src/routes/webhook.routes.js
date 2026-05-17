const express = require('express');
const router = express.Router();
const Transaction = require('../models/transaction.model');
const GiftCardTransaction = require('../models/giftCardTransaction.model');
const BankAccount = require('../models/bankAccount.model');
const { verifyWebhookSignature, createTransferRecipient, initiateTransfer } = require('../services/paystack.service');
const { verifyPrestmitWebhook } = require('../services/prestmit.service');
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

// Prestmit webhook — gift card sell approved/rejected
router.post('/prestmit', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-prestmit-signature'];

  if (!verifyPrestmitWebhook(req.body, signature)) {
    return res.status(401).json({ message: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).json({ message: 'Invalid JSON' });
  }

  const { event: eventType, data } = event;

  if (!['giftcard-trade.sell.approved', 'giftcard-trade.sell.rejected'].includes(eventType)) {
    return res.sendStatus(200);
  }

  // Match by uniqueIdentifier (which we set to our transaction _id)
  const uniqueId = data?.uniqueIdentifier || data?.partnersApiIdentifier;
  if (!uniqueId) return res.sendStatus(200);

  try {
    const transaction = await GiftCardTransaction.findOne({
      $or: [
        { _id: uniqueId.length === 24 ? uniqueId : null },
        { prestmitReference: data?.reference },
      ],
    }).populate('user', 'name email pushToken');

    if (!transaction) return res.sendStatus(200);

    if (eventType === 'giftcard-trade.sell.approved') {
      transaction.prestmitStatus = 'COMPLETED';

      // Initiate Paystack payout now that Prestmit confirmed the card
      try {
        const bankAccount = await BankAccount.findOne({ userId: transaction.user._id, isDefault: true });
        if (bankAccount && bankAccount.bankCode) {
          let recipientCode = transaction.paystackRecipientCode;
          if (!recipientCode) {
            recipientCode = await createTransferRecipient({
              accountName: bankAccount.accountName,
              accountNumber: bankAccount.accountNumber,
              bankCode: bankAccount.bankCode,
            });
            transaction.paystackRecipientCode = recipientCode;
          }
          const transfer = await initiateTransfer({
            recipientCode,
            amountNaira: transaction.amountNaira,
            reason: `Naivolt gift card payout — ${transaction.categoryName} ${transaction.currency}${transaction.denomination}`,
            reference: `naivolt_gc_${transaction._id}`,
          });
          transaction.paystackTransferCode = transfer.transfer_code;
        }
      } catch (payErr) {
        console.error('[Prestmit webhook] Paystack payout error:', payErr.message);
      }

      await transaction.save();

      if (transaction.user?.pushToken) {
        await sendPushNotification(transaction.user.pushToken, {
          title: '💸 Gift Card Approved!',
          body: `Your ${transaction.categoryName} gift card has been approved. Payment is on its way.`,
          data: { transactionId: transaction._id.toString(), type: 'giftcard_update' },
        }).catch(() => {});
      }
    } else {
      // rejected
      transaction.prestmitStatus = 'REJECTED';
      transaction.status = 'rejected';
      transaction.adminNote = transaction.adminNote || `Gift card rejected: ${data?.rejectionReason || 'Card could not be verified'}`;
      await transaction.save();

      if (transaction.user?.pushToken) {
        await sendPushNotification(transaction.user.pushToken, {
          title: '❌ Gift Card Not Approved',
          body: `Your ${transaction.categoryName} gift card could not be verified. Contact support.`,
          data: { transactionId: transaction._id.toString(), type: 'giftcard_update' },
        }).catch(() => {});
      }
    }
  } catch (err) {
    console.error('[Prestmit webhook] error:', err.message);
  }

  return res.sendStatus(200);
});

module.exports = router;
