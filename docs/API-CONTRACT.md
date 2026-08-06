# Naivolt v2 — client/API contract

**Status:** proposed by the mobile client, awaiting backend confirmation
**Consumed by:** `src/services/v2/client.ts` (typed in `src/services/v2/types.ts`)
**Companion to:** [ARCHITECTURE.md](./ARCHITECTURE.md)

---

## Why this document exists

`ARCHITECTURE.md` specifies the data model, the ledger invariants and the service
topology, but not the HTTP surface between them and the Expo app. The client is
built now, against the shapes below, with a mock implementation
(`src/services/v2/mock.ts`) standing in until the `api` crate serves them.

So this file is the client's side of the handshake: **these are the exact shapes
the app already parses.** Where the backend wants to differ, changing this
document and `types.ts` together is cheap; discovering the difference at
integration time is not.

Base path: `/api/v1`. Every route below requires a bearer access token unless
marked otherwise.

---

## 1. Conventions that aren't negotiable from the client side

### Money is a decimal string

```json
{ "balance": "248.415000", "ngnValue": "380074.9500" }
```

Never a JSON number. The ledger stores `NUMERIC(38,18)`; an IEEE-754 double
holds ~15–17 significant digits, so `0.1 + 0.2`-class error is guaranteed on
round-trip and a BTC balance loses precision outright. The client parses to a
number only at the moment of rendering, and never re-serialises a parsed value
back to the API.

This applies to `balance`, `ngnValue`, `rate`, `amount`, `amountNgn`, `fee`, and
every limit field.

### Errors carry a machine-readable code

```json
{ "code": "QUOTE_EXPIRED", "message": "That rate expired. Get a new one." }
```

The client branches on `code` and shows `message` verbatim. A bare HTTP 400 with
prose cannot be branched on, and each of these drives genuinely different UI:

| Code | HTTP | Client behaviour |
|---|---|---|
| `QUOTE_EXPIRED` | 409 | Clears the quote, switches the button to "Get a new rate" |
| `QUOTE_CONSUMED` | 409 | Same, plus refetches the portfolio — the sale may have landed |
| `INSUFFICIENT_BALANCE` | 422 | Inline field error under the amount |
| `LIMIT_EXCEEDED` | 422 | Inline error naming the limit from `meta.limit` |
| `PIN_INVALID` | 401 | Shakes and clears the PIN pad, stays on the screen |
| `PIN_LOCKED` | 423 | Blocks entry, tells the user when they can retry |
| `OTP_INVALID` / `OTP_EXPIRED` | 401 / 410 | Inline error, keeps the resend timer |
| `OTP_THROTTLED` | 429 | Disables resend until `meta.retryAfter` |
| `KYC_REQUIRED` | 403 | Routes to the KYC flow |
| `BANK_UNVERIFIED` | 422 | Routes to bank verification |
| `ASSET_PAUSED` | 503 | Disables trading for that asset, shows why |

`message` is shown to the user, so it must be safe to display: no stack traces,
no internal identifiers, no SQL. Anything without a `code` is treated as
`UNKNOWN`; anything with no response at all becomes `NETWORK`.

### Timestamps are ISO 8601 with an offset

`2026-07-29T18:40:12Z`. The quote countdown does wall-clock arithmetic against
`expiresAt`, so a naive local-time string without a zone will drift by the
device's offset — which in Nigeria is a silent one-hour error in the user's
favour or against it.

---

## 2. Balances

### `GET /portfolio`

The home screen's primary read. One call, because the balance hero, the asset
list and the naira row all render from it and three round-trips would show them
populating at different times.

```json
{
  "totalNgn": "464339.9500",
  "ngnBalance": "84250.0000",
  "changePct24h": 2.4,
  "holdings": [
    { "asset": "USDT", "balance": "248.415000", "ngnValue": "380089.9500", "rate": "1530.0000" }
  ]
}
```

**`ngnBalance` is the only field the app renders.** Home headlines it and Withdraw
calls it "Available" — the same number by design, so the app can never show a
balance larger than what the user can actually send to their bank.

- `ngnBalance` — spendable naira, from the **ledger**, never a chain RPC
  (ARCHITECTURE.md §2).
- `totalNgn`, `holdings`, `changePct24h` — still sent, still meaningful to the
  ledger and admin views, but **not surfaced in the app**. The client has no
  in-app path from a crypto balance to naira, so listing coins would show a
  number the user can't act on. Keep sending them; the shape stays stable if that
  path returns.

> **This raises a question the backend has to answer.** Deposit is still an
> action, so a user can send USDT to their address — but with no asset list and
> no sell flow, that crypto credits somewhere they can't see and can't spend.
> Either deposits auto-convert to naira on crediting (which makes this screen
> exactly right, and matches the product's original "send crypto, get naira"
> framing), or the app needs a conversion path back. As it stands, a crypto
> deposit is a dead end from the user's side. See §13.

### `GET /rates`

The rates board. Every asset we price, not only the ones the user holds.

```json
{
  "ngnPerUsd": "1520.0000",
  "asOf": "2026-07-29T22:14:03Z",
  "assets": [
    { "asset": "BTC",  "usdPrice": "63892.00000000", "rate": "97115840.0000", "changePct24h": -1.42 },
    { "asset": "USDT", "usdPrice": "0.99900000",     "rate": "1518.5300",     "changePct24h": 0.03 }
  ]
}
```

**`ngnPerUsd` is the headline and the pricing primitive.** It's what we pay per
dollar of value, margin already deducted, and it's the number Nigerian users mean
when they ask "what's the rate today?" — the one they compare between apps.
Every asset's `rate` is `usdPrice × ngnPerUsd`, so one figure drives the board.

`usdPrice` is the market price. Send it: the client leads each coin row with it
because it's the real market signal, and repeating a nine-digit naira figure on
every row is noise.

> **There is deliberately no mid rate and no spread field, and there must never
> be one.** The app quotes one number and pays exactly that number; our margin is
> embedded, not itemised. A mid rate on this payload is a value some screen
> eventually renders by accident, and it's visible to anyone watching the network
> regardless. Spread stays server-side — which is also the only place it can be
> *enforced*, since a client-computed one can be patched out of the bundle.

`changePct24h` is the asset's own 24h move (identical in USD or NGN terms),
nullable — send `null` rather than `0` when unavailable, so the client hides the
indicator instead of claiming a flat day.

**Interim client behaviour:** until this endpoint exists, the mock prices from
CoinGecko's USD feed and applies the margin locally via
`src/constants/pricing.ts`. One thing there needs porting rather than
reimplementing:

> **Don't use CoinGecko's `vs_currency=ngn`.** It's derived from the *official*
> USD/NGN rate and currently prices USDT around ₦1,364, against a parallel market
> well north of that — roughly 10-12% below what competitors quote. Take the USD
> price, which is a real deep-market number, and multiply by our own naira rate.
> That rate is a business input and should track the parallel market.

---

## 3. Deposits

### `GET /wallets/deposit-address?asset={asset}&chain={chain}`

```json
{
  "asset": "USDT",
  "chain": "tron",
  "network": "TRC-20",
  "address": "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE",
  "minConfirmations": 20,
  "minimumDeposit": "1.000000"
}
```

- Derived from `user.address_index`, so it's stable forever. The client caches it
  with `staleTime: Infinity` and tells the user it's permanently theirs.
- `network` is the **user-facing** label — `TRC-20`, `BEP-20`, `ERC-20` — the
  string their sending wallet shows them, not the internal chain enum. This is
  rendered in the "network only" warning, and a mismatch between what we print
  and what Binance prints is how people lose funds.
- `memo` — include only when the chain requires it. Its presence makes the client
  render a second copy field; sending `""` or `null` is fine, sending a bogus
  value is not.
- Should this 4xx for an unsupported asset/chain pair rather than deriving
  something unusable? The client treats a non-200 here as fatal for the screen.

### `GET /deposits?status=pending`

Drives the confirmation tracker. Polled every 6s **only while non-empty**.

```json
[
  {
    "id": "d1",
    "asset": "USDT",
    "chain": "tron",
    "amount": "50.000000",
    "txHash": "9f2c…1f2a",
    "confirmations": 7,
    "minConfirmations": 20,
    "status": "confirming",
    "createdAt": "2026-07-29T18:39:27Z"
  }
]
```

`status` ∈ `detected | confirming | credited | reversed`. Both
`confirmations` and `minConfirmations` are needed on every row — the client
renders "13 more to go" and a progress bar, and hardcoding the threshold
client-side would go stale the moment ops retunes it.

---

## 4. Selling (quotes)

### `POST /quotes`

```json
// →
{ "asset": "USDT", "amount": "100.000000" }
// ←
{
  "id": "q_1769712012_USDT",
  "asset": "USDT",
  "amount": "100.000000",
  "rate": "1530.0000",
  "ngnValue": "153000.0000",
  "expiresAt": "2026-07-29T18:41:12Z",
  "windowSeconds": 60
}
```

- `rate` is what the **user receives** — mid minus spread. The client displays
  this figure as the rate, so sending the mid here would overstate what they get.
- `windowSeconds` is sent explicitly rather than assumed to be 60, so the
  countdown bar scales correctly if the window is ever retuned server-side.
- `ngnValue` is authoritative. The client shows the server's figure rather than
  computing `amount × rate`, so what the user confirms is exactly what the ledger
  will write.

### `POST /quotes/{id}/execute`

No body. Returns the resulting activity item (see §6).

Consumption must be atomic — one quote, one trade (ARCHITECTURE.md §9). The
client **never retries this call**, on any error, because a blind retry after an
ambiguous failure risks selling twice. On `QUOTE_CONSUMED` it refetches the
portfolio rather than assuming the sale failed.

---

## 5. Payouts

### `GET /bank-accounts`

```json
[
  {
    "id": "b1",
    "bankCode": "058",
    "bankName": "GTBank",
    "accountNumber": "0123454821",
    "accountName": "ADEYEMI DIVINE",
    "verifiedAt": "2026-07-17T09:12:00Z"
  }
]
```

`verifiedAt: null` means unverified; the client blocks selecting it as a payout
destination.

### `GET /limits`

Fetched **before** the amount field is usable, so caps are stated up front rather
than surfaced as an error after the user has typed a number.

```json
{
  "kycTier": 2,
  "dailyRemainingNgn": "850000.0000",
  "dailyLimitNgn": "1000000.0000",
  "perTransactionMaxNgn": "500000.0000",
  "minWithdrawalNgn": "1000.0000"
}
```

### `GET /banks`

The provider's institution list, for the send-to-any-account flow.

```json
[
  { "code": "058", "name": "GTBank", "kind": "bank" },
  { "code": "999992", "name": "OPay", "kind": "fintech" }
]
```

`kind` ∈ `bank | fintech | microfinance`, optional. The client groups fintechs
first in the unfiltered picker — a large share of Nigerian transfers go to OPay,
PalmPay, Kuda or Moniepoint, and burying those under an alphabetical run of
commercial banks puts the most-used destinations at the bottom of the list.

### `GET /banks/resolve?bank_code={code}&account_number={number}`

Name enquiry. **This is the only thing standing between a mistyped digit and an
irreversible transfer to a stranger**, so the client treats it as a hard gate:
it fires automatically on the tenth digit, and the Continue button stays disabled
until a name comes back. There is no "send anyway" path.

```json
{ "accountName": "ADEYEMI DIVINE", "bankCode": "058", "accountNumber": "0123454821" }
```

Return the name **verbatim** from the bank — upper-case, odd spacing and all. The
client renders it unmodified in mono, because a prettified version means the user
is comparing against something the bank doesn't actually hold.

A not-found account should carry a distinguishable code; the client currently
shows `message` for any failure here.

### `GET /bank-accounts`

Saved beneficiaries. **Ordering matters**: most-recently-paid first, never-used
last. The client renders them in the order received and tags the first as
"Recent", because paying the same account again is the overwhelmingly common case
and it should be the top row.

`lastUsedAt` (nullable) and `nickname` (nullable) are new — see §5's shape.

### `POST /bank-accounts` · `DELETE /bank-accounts/{id}`

Add and remove beneficiaries: `{ bankCode, accountNumber, accountName, nickname? }`.

### `POST /payouts`

```
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
```
```json
// → saved beneficiary
{
  "amountNgn": "150000.0000",
  "destination": { "kind": "beneficiary", "bankAccountId": "b1" },
  "pin": "••••••"
}

// → any account the user typed
{
  "amountNgn": "150000.0000",
  "destination": {
    "kind": "oneOff",
    "bankCode": "058",
    "accountNumber": "0123454821",
    "accountName": "ADEYEMI DIVINE",
    "save": true
  },
  "pin": "••••••"
}
// ←
{
  "id": "p_1769712140",
  "amountNgn": "150000.0000",
  "fee": "10.0000",
  "bankAccount": { "bankName": "GTBank", "accountNumber": "0123454821", "accountName": "ADEYEMI DIVINE" },
  "status": "processing",
  "reference": "NVLT-1769712140",
  "createdAt": "2026-07-29T18:42:20Z",
  "settledAt": null
}
```

**On the idempotency key:** the client generates one UUID when the user reaches
the PIN screen and reuses it for **every** submit attempt of that same intent —
including after a wrong PIN. So:

- a `PIN_INVALID` retry with the correct PIN carries the same key and must be
  treated as the same intent, not rejected as a replay;
- a network timeout followed by a retry must never produce a second transfer.

If the backend would rather scope the key per-attempt, that needs deciding here,
because the current client behaviour depends on it.

`status` ∈ `reserved | processing | settled | failed | reversed`.
`failureReason` accompanies `failed`/`reversed` and is shown to the user.

`destination` is a discriminated union rather than a nullable `bankAccountId`,
because the two cases are genuinely different server-side: `oneOff` has to run
name enquiry and apply third-party transfer rules before it can reserve funds.
`accountName` is echoed back on `oneOff` so the server can assert the client
showed the user the same name it verified — if they disagree, something changed
between enquiry and submit and the payout should be refused rather than sent.

`save: true` means persist as a beneficiary **after** the payout succeeds. A
destination that failed shouldn't end up in the user's list.

> **This needs your decision, not mine.** ARCHITECTURE.md §8 lists a *name-match
> between the bank account and the KYC name* among the payout guards. The
> `oneOff` flow above is, by definition, how a user pays an account that may not
> match their own name — so as specified, that guard rejects it.
>
> That's an AML question for a custodial VASP, not a UI one: third-party payouts
> are the classic layering route, and Nigeria's SEC/CBN obligations (§14) bear on
> it directly. Options, roughly: allow third-party sends above a KYC tier with
> velocity caps and screening; restrict them to name-matched accounts only; or
> allow them with a manual-review threshold. The client is built for the general
> case and will happily disable the "New account" tab if you return
> `KYC_REQUIRED` or a new `THIRD_PARTY_NOT_ALLOWED` code — tell me which and I'll
> wire it.

---

## 6. Activity

### `GET /activity?cursor={cursor}`

The unified feed. One list, all kinds — the client deliberately does not have
separate deposit and payout histories, since "where is my money" is one question.

```json
{
  "items": [
    {
      "id": "a1",
      "kind": "sell",
      "asset": "USDT",
      "amount": "100.000000",
      "ngnValue": "153000.0000",
      "status": "completed",
      "createdAt": "2026-07-29T15:40:00Z",
      "detail": "Sold at ₦1,530"
    }
  ],
  "nextCursor": null
}
```

- `kind` ∈ `deposit | sell | giftcard | payout | reversal`.
  `giftcard` rows currently come from the **v1** endpoint
  (`POST /gift-cards/transactions`), not from this feed — see §10.
- Derived from ledger journals server-side. The client never reconstructs a
  balance by replaying this feed.
- **Sign convention:** all amounts are unsigned. The client derives direction
  from `kind` and renders it from the *user's* perspective — a deposit reads as
  money in. Do not send the ledger's own signs (liabilities negative per
  ARCHITECTURE.md §5); that's correct accounting and would render backwards.
### `GET /activity/{id}`

The receipt. Everything the feed row carries, plus the evidence a user needs when
something is delayed or disputed.

```json
{
  "id": "a2", "kind": "payout", "asset": "NGN",
  "amount": "150000.0000", "ngnValue": "150000.0000",
  "status": "settled", "createdAt": "2026-08-02T09:12:00Z",
  "reference": "NV-A2",
  "bankName": "GTBank", "accountNumber": "••••••4821", "accountName": "ADEYEMI DIVINE",
  "fee": "0.0000",
  "timeline": [
    { "label": "Requested",        "at": "2026-08-02T09:12:00Z", "state": "done" },
    { "label": "Sent to your bank","at": "2026-08-02T09:12:04Z", "state": "done" },
    { "label": "Settled",          "at": "2026-08-02T09:13:31Z", "state": "done" }
  ]
}
```

All fields beyond `ActivityItem` are optional and kind-specific — a payout has no
`txHash`, a deposit has no `bankName`. The screen renders what's present.

**`timeline` is the important one.** `state` ∈ `done | current | pending |
failed`, `at` is null for a step not yet reached. "Pending" is not an answer to
"where is my money" — a user wants the step it's sitting on, so please send the
real sequence per kind (a deposit confirms on chain, a gift card is reviewed by a
person, a payout settles at a bank) rather than a generic three-step shape.

`reference` should be what support can look up. The client shows it prominently
and includes it in the shared receipt.

The client polls this every 10s while the item is in flight and stops on a
terminal status, so it doesn't need a websocket.

- `detail` is a short, already-formatted human string for the row's subtitle
  (`"GTBank ···4821"`, `"TRC-20 · 20 confirmations"`). Server-side because it
  varies by kind and the client shouldn't hold a formatting switch per kind.
- Ordering: newest first. The client groups into Today / Yesterday / date
  headers and relies on that order.

---

## 7. Auth — not yet built client-side

ARCHITECTURE.md §10 specifies passwordless OTP + device PIN. The app currently
runs the v1 email/password flow. Endpoints the redesigned flow will need:

| Route | Purpose |
|---|---|
| `POST /auth/otp/request` | `{ identifier }` (phone or email) → `{ retryAfter, channel }` |
| `POST /auth/otp/verify` | `{ identifier, code, deviceId }` → tokens + `isNewUser` |
| `POST /auth/pin` | Set PIN on first login |
| `POST /auth/refresh` | Rotating refresh, bound to `deviceId` |

Two things the client needs decided before building it:

1. **Does `otp/verify` return whether a PIN is already set?** It determines
   whether the user lands on "create a PIN" or the app. Returning it avoids an
   extra round-trip on every login.
2. **Reuse detection** revokes the token family (§10). The client needs a
   distinguishable code for that — being silently logged out is
   indistinguishable from a bug, and the user should be told to sign in again.

---

## 8. Open questions for the backend

1. **`GET /portfolio` shape** — happy to split into `/balances` + `/rates` if
   that's cheaper server-side, but the client wants one call for the home screen
   so the hero and rows can't disagree.
2. **Idempotency key scoping** on `POST /payouts` — per intent (current client
   behaviour) or per attempt?
3. **Paused assets** — is `ASSET_PAUSED` returned from `POST /quotes`, or should
   `/portfolio` carry a per-holding `tradable` flag so the UI can disable Sell
   before the user taps it? The second is better UX; the first is less state.
4. **Rate freshness** — when quoting freezes on >2% source divergence (§9), what
   does `POST /quotes` return? The client currently has no path for "rates
   temporarily unavailable" distinct from a generic failure.
5. **Push notifications** — payload shape for `transfer.success` / deposit
   credited, so taps can deep-link to the right activity row.

---

## 10. Gift cards

Selling a gift card is the primary action on the home bar. It now runs through
the v2 adapter like every other surface — it was the last screen calling v1
directly, and the only one that broke when that backend was removed.

### `GET /gift-cards/brands`

```json
[
  {
    "id": "gc_amazon",
    "name": "Amazon",
    "slug": "amazon",
    "logoUrl": "https://…",
    "requiresImage": true,
    "hasPin": false,
    "note": "Receipt required for cards over $200.",
    "rates": [
      {
        "countryCode": "US",
        "countryName": "United States",
        "currency": "USD",
        "ratePerUnit": "1080.0000",
        "minFaceValue": "10.00",
        "maxFaceValue": "1000.00"
      }
    ]
  }
]
```

- `ratePerUnit` is naira per unit of face value. **Not** derived from the crypto
  per-dollar rate in §12 — cards carry fraud and chargeback risk a confirmed
  on-chain deposit doesn't, and clear well below it. These are a business input
  per brand and country.
- `requiresImage` / `hasPin` drive which fields the form shows. Sending them per
  brand means the client doesn't hardcode a list of which brands have PINs.
- `note` is an operational caveat rendered before submit ("Receipt required").
- Country is a required user choice because the same brand clears at very
  different rates by country — that spread is the main thing a seller compares.

### `POST /gift-cards/submissions` (multipart/form-data)

```
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000

brandId, countryCode, faceValue, cardCode, cardPin?, cardImage
```

Returns the submission:

```json
{
  "id": "gcs_1",
  "brandName": "Amazon",
  "countryCode": "US",
  "faceValue": "100.00",
  "currency": "USD",
  "payoutNgn": "108000.0000",
  "status": "pending",
  "reference": "NVGC-1700000",
  "createdAt": "2026-07-31T09:12:00Z"
}
```

`status` ∈ `pending | reviewing | approved | rejected`; `rejectionReason`
accompanies `rejected` and is shown to the user.

**Manual review flow**: this returns `pending` and naira is credited only on
approval. The client does not move the balance on submit.

The idempotency key is minted once per card when the brand is selected and reused
across retries. A card code is single-use, so the client never auto-retries this
call — but a *deliberate* retry after an ambiguous failure must not create a
second submission.

### Still open: gift cards and the ledger

Gift card rows appear in `GET /activity` with `kind: "giftcard"` (the client
renders the label, inbound direction and filters already). The deeper question is
whether approval writes a **ledger journal** crediting `user_ngn`, or stays a
side-channel credit.

It should be a journal. A manual payout that never touches the ledger is exactly
the v1 problem ARCHITECTURE.md §1 sets out to remove, and without one, gift card
liabilities are invisible to the reconciliation in §2 — meaning the NGN float
check silently understates what we owe.

---

## 14. Push notifications

The app registers for push at the moment it promises one — right after a
withdrawal or a gift card submission, not on first launch. (A prompt before the
user has anything pending gets denied, and on iOS a denial is close to permanent.)

### `POST /devices/push-token`

```json
{ "token": "ExponentPushToken[xxxxxxxx]", "deviceId": "…", "platform": "ios" }
```

Store per `deviceId`, not per user — someone with two phones should get both, and
signing out on one must drop only that one. Re-registering the same `deviceId`
replaces the token; they rotate on reinstall.

### What to send, and what not to

Push only what the user is **waiting on and cannot see**:

| Event | Example |
|---|---|
| Deposit credited | "₦380,074 from your USDT deposit is available" |
| Payout settled | "₦150,000 arrived at GTBank ···4821" |
| Payout failed / reversed | "Your ₦150,000 transfer was returned" |
| Gift card approved / rejected | "Your Amazon card cleared — ₦108,000 added" |

Do **not** push a payout that was just submitted: the user was looking at the
screen when they submitted it. A notification that tells someone what they
already know is what trains them to swipe the next one away unread.

### Payload

`data` must carry the activity id so a tap opens the right receipt:

```json
{ "kind": "payout", "activityId": "p_1769712140" }
```

The client deep-links to `/activity/{activityId}` on tap, and invalidates the
balance and activity caches on arrival — a notification means the server state
changed, so the cached figures are stale by definition.

Android uses a `transactions` channel at HIGH importance with
`PRIVATE` lockscreen visibility, so amounts don't render on a locked screen.

---

## 12. The margin model

Pricing runs through **one number**: naira per dollar of value.

```
payout = assetAmount × assetUsdPrice × (ngnPerUsdMid − SPREAD_NAIRA_PER_USD)
```

Config lives in `src/constants/pricing.ts`:

| Constant | Env override | Default |
|---|---|---|
| `USD_NGN_MID` | `EXPO_PUBLIC_USD_NGN_RATE` | 1530 |
| `SPREAD_NAIRA_PER_USD` | `EXPO_PUBLIC_SPREAD_NGN_PER_USD` | 10 |

Because the margin is charged per *dollar* and not per *coin*, it lands
identically on every asset. Verified against live CoinGecko prices at a ₦1,530
mid, ₦10 margin (headline rate ₦1,520/$):

| Asset | USD price | ₦ per unit | Margin on a ₦1,000,000 sale |
|---|---|---|---|
| BTC | $63,892 | ₦97,115,840 | ₦6,536 |
| ETH | $1,903.42 | ₦2,893,198 | ₦6,536 |
| BNB | $570.35 | ₦866,932 | ₦6,536 |
| SOL | $73.50 | ₦111,720 | ₦6,536 |
| USDT | $0.999 | ₦1,518.53 | ₦6,536 |
| TRX | $0.326 | ₦494.83 | ₦6,536 |

**₦10/$ works out to 0.65% flat.** ARCHITECTURE.md §9 targets 1.3%, which is
`SPREAD_NAIRA_PER_USD = 20` — one constant, no per-asset table.

This is worth contrasting with the alternative reading of "a ₦10 gap", which is
₦10 off each *coin's* rate. That model collapses, because one BTC is worth
~64,000 USDT: it earns ₦10 total on a ₦98,000,000 BTC sale (0.00001%) while
charging 2% on TRX. Per dollar, one constant covers everything — which is also
why the client has no per-asset spread config to keep in sync.

---

## 13. Open: what happens to a crypto deposit?

The app now shows **one balance — spendable naira** — and no per-asset breakdown.
Combined with the removal of the crypto Sell flow, that leaves a gap on the
deposit side that only the backend can close.

Today a user can still tap Deposit, get a real TRC-20 address, and send USDT. The
watcher credits it (§6). But there is no screen where that balance appears and no
action that converts it, so from the user's side the money vanishes.

Two coherent resolutions:

1. **Auto-convert on credit.** When a deposit reaches its confirmation threshold,
   sell it at the prevailing rate in the same journal that credits the user, so
   `user_ngn` moves and `user_crypto` never holds a balance. This makes the
   current UI exactly right, and matches the product's original framing — send
   crypto, get naira, no portfolio. It also removes the spread-timing question,
   since the rate is applied once, at crediting.

2. **Restore a conversion path** in the app, which means bringing back the sell
   flow and with it the asset list.

Option 1 is the smaller system and fits what the client now looks like. Whichever
is chosen, it needs deciding before deposits are enabled for real users — the
current combination silently strands funds, which is the one failure mode this
architecture exists to prevent.

If option 1: `GET /activity` should report those as a single `deposit` row with
the naira credited, not a deposit followed by a synthetic sell. The client renders
one event per thing that happened to the user.

---

## 9. Switching the client over

The app reads these flags (`src/constants/features.ts`):

| Flag | Default | Meaning |
|---|---|---|
| `EXPO_PUBLIC_FEATURE_EXCHANGE_V2` | `true` | Show the v2 surfaces |
| `EXPO_PUBLIC_USE_MOCK_EXCHANGE` | `__DEV__` | Serve v2 data from the fixture |

When the endpoints above are live, set `EXPO_PUBLIC_USE_MOCK_EXCHANGE=false`.
No screen changes are needed — `httpExchange` and `mockExchange` implement the
same `ExchangeService` interface.

The mock defaults to on in development and **off in any release build**, so a
production binary can never serve fixture balances by accident — showing someone
a fabricated balance is not a failure mode worth risking on an unset environment
variable.
