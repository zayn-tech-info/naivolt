const axios = require('axios');
const crypto = require('crypto');

const paystackApi = axios.create({
  baseURL: 'https://api.paystack.co',
  headers: {
    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

async function createTransferRecipient({ accountName, accountNumber, bankCode }) {
  const { data } = await paystackApi.post('/transferrecipient', {
    type: 'nuban',
    name: accountName,
    account_number: accountNumber,
    bank_code: bankCode,
    currency: 'NGN',
  });
  return data.data.recipient_code;
}

async function initiateTransfer({ recipientCode, amountNaira, reason, reference }) {
  const { data } = await paystackApi.post('/transfer', {
    source: 'balance',
    amount: Math.round(amountNaira * 100), // kobo
    recipient: recipientCode,
    reason,
    reference,
  });
  return data.data; // { transfer_code, status, ... }
}

function verifyWebhookSignature(rawBody, signature) {
  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest('hex');
  return hash === signature;
}

module.exports = { createTransferRecipient, initiateTransfer, verifyWebhookSignature };
