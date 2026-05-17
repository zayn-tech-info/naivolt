const axios = require('axios');
const crypto = require('crypto');
const FormData = require('form-data');
const fs = require('fs');

const BASE_URL = process.env.PRESTMIT_SANDBOX === 'true'
  ? 'https://dev-api.prestmit.io/partners/v1'
  : 'https://api.prestmit.io/partners/v1';

const API_KEY = process.env.PRESTMIT_API_KEY || '';
const API_SECRET = process.env.PRESTMIT_API_SECRET || '';
const WEBHOOK_SECRET = process.env.PRESTMIT_WEBHOOK_SECRET || '';

function signRequest(bodyObj = {}) {
  const payload = `${API_KEY}:${JSON.stringify(bodyObj)}`;
  return crypto.createHmac('sha256', API_SECRET).update(payload).digest('hex');
}

function authHeaders(bodyObj = {}) {
  return {
    'API-KEY': API_KEY,
    'API-Hash': signRequest(bodyObj),
    Accept: 'application/json',
  };
}

// GET /giftcard-trade/sell/rate-calculator-data
async function getRates() {
  const res = await axios.get(`${BASE_URL}/giftcard-trade/sell/rate-calculator-data`, {
    headers: authHeaders(),
    timeout: 15000,
  });
  return res.data;
}

/**
 * Submit a gift card sell transaction to Prestmit.
 * @param {object} opts
 * @param {number} opts.giftcardId   - Prestmit sellableGiftcards[].id
 * @param {number} opts.amount       - face value (denomination)
 * @param {string} opts.imagePath    - local file path OR remote URL for proof image
 * @param {string} opts.cardCode     - the gift card code/ecode
 * @param {string} opts.uniqueId     - your internal transaction _id (idempotency key)
 */
async function submitSellTransaction({ giftcardId, amount, imagePath, cardCode, uniqueId }) {
  // Build hash body (without attachments)
  const hashBody = {
    giftcard_id: giftcardId,
    amount,
    payoutMethod: 'NAIRA',
    comments: cardCode,
    uniqueIdentifier: uniqueId,
  };

  const form = new FormData();
  form.append('giftcard_id', String(giftcardId));
  form.append('amount', String(amount));
  form.append('payoutMethod', 'NAIRA');
  form.append('comments', cardCode);
  form.append('uniqueIdentifier', uniqueId);

  // Attach proof image — support both local path and remote URL
  if (imagePath.startsWith('http')) {
    // Download remote image into a buffer then append
    const imgRes = await axios.get(imagePath, { responseType: 'arraybuffer', timeout: 20000 });
    const ext = imagePath.split('.').pop()?.split('?')[0] || 'jpg';
    form.append('attachments[]', Buffer.from(imgRes.data), {
      filename: `proof.${ext}`,
      contentType: `image/${ext === 'png' ? 'png' : 'jpeg'}`,
    });
  } else {
    form.append('attachments[]', fs.createReadStream(imagePath));
  }

  const res = await axios.post(`${BASE_URL}/giftcard-trade/sell/create`, form, {
    headers: {
      ...authHeaders(hashBody),
      ...form.getHeaders(),
    },
    timeout: 30000,
  });

  return res.data; // { success, details, trade: { reference, rate, status, ... } }
}

// GET /giftcard-trade/sell/history?reference=xxx
async function getSellTransaction(reference) {
  const res = await axios.get(`${BASE_URL}/giftcard-trade/sell/history`, {
    params: { reference },
    headers: authHeaders(),
    timeout: 15000,
  });
  return res.data;
}

// Verify incoming Prestmit webhook signature
function verifyPrestmitWebhook(rawBody, signatureHeader) {
  if (!WEBHOOK_SECRET) return false;
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody)
    .digest('base64');
  return expected === signatureHeader;
}

module.exports = { getRates, submitSellTransaction, getSellTransaction, verifyPrestmitWebhook };
