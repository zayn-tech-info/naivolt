# Virtual numbers

Selling one-shot phone numbers that receive a single verification code. Naira
priced, paid from the user's balance, supplied by 5SIM.

The web dashboard is the only client today — the Expo app has no numbers UI.

---

## 1. The money path

A number order is a payout with a different counterparty, and it borrows that
design wholesale (ARCHITECTURE.md §8):

```
reserve   user_ngn:{u}            +620     liability shrinks
          number_payable_pending  -620     owed back if no code arrives

settle    number_payable_pending  +620     discharged
          number_revenue          -620     recognised — the code landed

refund    number_payable_pending  +620     discharged
          user_ngn:{u}            -620     owed to the user again
```

Two orderings carry the whole design.

**Naira leaves the spendable balance before the supplier is called**, under
`SELECT … FOR UPDATE` on the user's NGN account. Two taps on Buy serialise; the
second sees the balance the first already reduced. A crash between reserving and
buying leaves money reserved and an order to reconcile, never money spent twice.

**Revenue is recognised on delivery, not on purchase.** An order that never
receives a code was never a sale. Settling at purchase would book revenue we then
have to claw back on every failed activation — and failed activations are common.

A refund *reverses* the reservation rather than writing a compensating credit, so
no rounding step or double refund can leave a user short.

## 2. Funding

The mirror image, and different in the way that matters: the card is charged by
someone else's system, so there is nothing to reserve up front.

```
credit    ngn_float     +5,000    the money is ours to hold
          user_ngn:{u}  -5,000    and we owe the user that much
```

Nothing is written to the ledger when an intent is created. Crediting on intent
would fund an account from a card that later declines, against a balance the user
may already have spent. The credit is keyed on the provider's own reference, so a
poll, a webhook and a manual replay of one charge are one event.

We credit **what Paystack says it took**, not what we asked for.

Verification is by polling `/transaction/verify`. That endpoint is authoritative
and needs no signature handling, so no forged POST can credit an account. A
webhook belongs in front of this as a latency optimisation, not as the thing that
makes it correct.

### The round trip

Paystack takes the money on its own page, which means the payer leaves the site
and has to be brought back:

```
POST /funding/intents          row written first, then Paystack is called
  → callback_url = {WEB_APP_URL}/dashboard?intent={id}
  → browser follows authorization_url

…user pays…

GET  /dashboard?intent=…&reference=…    Paystack appends its own reference
  → GET /funding/intents/{id}           verifies, credits, shows the balance
```

The intent id travels on the callback URL because Paystack's own `reference` is
the only thing it adds, and the dashboard would otherwise have to guess which
top-up finished. The id is also written to `localStorage` before the redirect,
for the payer who comes back by some other route — a bookmark, a reopened tab, a
browser that drops the query string.

**A payer who never comes back is still a payer who was charged.** The dashboard
confirming on return is the fast path, not the guarantee. `funding_reconciler.rs`
sweeps pending intents every 30 seconds and settles them against the same verify
call, so the balance is right whether or not anyone is looking at the page.
Intents older than 24 hours are marked abandoned rather than verified forever.

## 3. Endpoints

```
GET  /api/v1/numbers/catalog          products x countries x price, public
POST /api/v1/numbers/orders           reserve + buy        (Idempotency-Key)
GET  /api/v1/numbers/orders           the user's orders
GET  /api/v1/numbers/orders/:id       asks the supplier, advances the order

POST /api/v1/funding/intents          create + initialise  (amountNgn)
GET  /api/v1/funding/intents/:id      verifies, credits on success
GET  /api/v1/funding/intents          the user's top-ups
```

`GET /numbers/orders/:id` is where an order moves. The client polls it; there is
no worker, because the only orders needing chased are ones a user is watching.

## 4. Providers

Both are enums, not direct calls, and for a reason that already happened:
**SMS-Activate closed in December 2025** after ten years, moved its infrastructure
elsewhere, and set a $30 minimum withdrawal that stranded every smaller balance.
A second supplier must be a variant, not a rewrite.

| Env | Missing means |
|---|---|
| `FIVESIM_API_KEY` | stub numbers (`+000…`, code `123456`). Production refuses to boot. |
| `FIVESIM_CURRENCY` | supplier cost is read as USD — see §5 |
| `PAYSTACK_SECRET_KEY` | stub funding, credits instantly, takes no money |
| `GOOGLE_CLIENT_ID` | `/auth/google` returns 503 |
| `WEB_APP_URL` | card payers are returned to `localhost`. Production refuses to boot. |
| `NUMBERS_MARGIN` | defaults to 1.6× supplier cost |

## 5. The catalogue is synced, not typed

`number_prices` began as 72 hand-written rows with `stock` left at 0 on every one
of them. The catalogue endpoint reads `in_stock: stock > 0`, so **every number on
the dashboard was showing as unavailable**, and `provider_cost` was never filled
in, so nothing in the system knew what any of them cost us.

`number_catalog.rs` fixes both from one request per country — 5SIM's *guest*
endpoints need no API key, so this works in development too:

```
GET /v1/guest/products/nigeria/any
{"whatsapp":{"Category":"activation","Qty":1554232,"Price":0.28}, …}
```

**The sale price is derived from the supplier's.** A hand-set naira price goes
stale in the dangerous direction: 5SIM had moved US WhatsApp to $0.90 (≈₦1,395)
while the table still said ₦1,010, so every US sale lost money and nothing said
so. Price is now `cost × USD/NGN × NUMBERS_MARGIN`, rounded **up** to ₦10, and a
recomputed price within 5% of the stored one is left alone so the number a user is
reading is still that price when they buy it. Beyond that, `POST /numbers/orders`
takes an `expectedPriceNgn` and answers `409 PRICE_MOVED` rather than charging
more than the page displayed.

**The unit is dollars, and it was settled by arithmetic.** 5SIM quotes a bare
number and never names the currency. US WhatsApp at 0.90 and Instagram at 0.06
are only coherent as dollars — no activation anywhere costs six hundredths of a
rouble. `FIVESIM_CURRENCY` is believed over that inference: set to anything other
than USD, the sync records stock and cost but leaves prices alone rather than
converting through a rate it was never given.

A failed fetch leaves the previous catalogue in place. A supplier we cannot reach
is not a supplier with nothing in stock, and zeroing the table on a timeout would
empty the shop.

## 6. Running it

```sh
createdb naivolt_dev
# The API owns migrations — running them by hand leaves sqlx unaware and it
# will try to re-apply 0001 at boot.
set -a && . ./backend-rs/.env.local && set +a
cargo run -p naivolt-api
DATABASE_URL=postgres://localhost/naivolt_dev cargo run -p naivolt-devtools --bin seed
```

`BIND_ADDR` is **not** the default 5000 locally: macOS Control Center listens
there for AirPlay and answers 403, which reads exactly like a bug in our code.

### Going live

Everything above runs today on stubs and the guest catalogue. Four things turn it
into a business, in this order:

1. **A funded 5SIM account.** Register, then Profile → API key for
   `FIVESIM_API_KEY`. The key alone buys nothing: the balance is the supplier
   float, and it must be **company money** — never customer USDT, which would
   break the invariant in ARCHITECTURE.md §2. Confirm the unit while funding it:
   deposit a known amount and read `/v1/user/profile`. That is what settles
   `FIVESIM_CURRENCY` and unblocks the cost-of-goods leg in §7.
2. **A Paystack account off test keys.** `PAYSTACK_SECRET_KEY` and a
   `WEB_APP_URL` that is the deployed dashboard, not localhost — production
   refuses to boot on either mistake. Read §14 first: Paystack's terms restrict
   crypto-related processing, and collections are more exposed than payouts.
3. **Measure delivery before promising it.** Buy twenty numbers on the products
   you intend to sell and count how many receive a code. The refund path has
   never run against a real supplier, and a stub that always delivers cannot
   exercise expiry.
4. **Then set the margin.** `NUMBERS_MARGIN` is 1.6 as a placeholder. The real
   figure is whatever covers the failures measured in step 3 — an activation that
   delivers half the time costs twice its price to deliver once.

## 7. Open

- **Cost of goods is still not booked.** `provider_cost` is recorded on every row
  now, but no ledger leg carries it: the currency is inferred (§5), and a guessed
  unit written into an append-only ledger is permanent. Confirm it against a
  funded 5SIM balance — deposit a known amount, read `/v1/user/profile` — then
  add the leg.
- **Delivery rates are unmeasured.** The success figures on the pools sampled at
  build time were 2.26% (WhatsApp US) and 8.25% (UK). Buy 20 and measure before
  promising anything. A 1.6× margin on a product that delivers a tenth of the
  time is not a margin.
- **Supplier float must be company money.** Never customer USDT — §2's invariant
  is `Σ custody ≥ Σ user liabilities`, and paying a supplier from it breaks that.
  `supplier_float` exists for this and is deliberately kept thin.
- **The refund path has never run against a real supplier.** It is unit-tested;
  the stub always delivers, so expiry cannot be exercised locally.
- **Paystack's terms restrict crypto-related processing** (§14). Collections are
  more exposed than payouts: a frozen collections account stops money entering,
  not merely leaving. Confirm before depending on it.
