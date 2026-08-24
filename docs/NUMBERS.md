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
| `FIVESIM_CURRENCY` | supplier cost recorded without a unit |
| `PAYSTACK_SECRET_KEY` | stub funding, credits instantly, takes no money |
| `GOOGLE_CLIENT_ID` | `/auth/google` returns 503 |

## 5. Running it

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

## 6. Open

- **The supplier's currency is unconfirmed.** 5SIM's guest API quotes a bare
  number and never names the unit. `provider_cost` is recorded as reported and
  **no ledger leg books cost of goods**, because a guessed unit written into an
  append-only ledger is permanent. Set `FIVESIM_CURRENCY` and add the leg once a
  funded account settles it.
- **Delivery rates are unmeasured.** The success figures on the pools sampled at
  build time were 2.26% (WhatsApp US) and 8.25% (UK). Buy 20 and measure before
  promising anything.
- **Supplier float must be company money.** Never customer USDT — §2's invariant
  is `Σ custody ≥ Σ user liabilities`, and paying a supplier from it breaks that.
  `supplier_float` exists for this and is deliberately kept thin.
- **The refund path has never run against a real supplier.** It is unit-tested;
  the stub always delivers, so expiry cannot be exercised locally.
- **Paystack's terms restrict crypto-related processing** (§14). Collections are
  more exposed than payouts: a frozen collections account stops money entering,
  not merely leaving. Confirm before depending on it.
