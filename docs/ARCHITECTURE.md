# Naivolt v2 — Custodial Exchange Architecture

**Status:** design, approved for build
**Stack:** Rust (axum, sqlx, tokio) + PostgreSQL 16 + Redis
**Chains:** TRON (TRC-20), EVM (Ethereum/BSC/Polygon/Base), Bitcoin, Solana
**Auth:** passwordless OTP (phone or email) + device PIN/biometric
**Migration:** greenfield — no data carried over from the Mongo/Express system

---

## 1. What changes, and why

The v1 system has no wallet infrastructure. It has a pool of manually pre-seeded
addresses (`walletAddress.model.js`); an admin hands one out per transaction, the
user pastes a tx hash and uploads a screenshot, an admin eyeballs it and clicks
approve, and then Paystack pays out. Every deposit costs an admin's attention,
and correctness rests on a human reading a screenshot.

v2 replaces that with real custody:

| | v1 | v2 |
|---|---|---|
| Deposit address | shared pool, assigned per tx | one permanent address per user per chain, derived deterministically |
| Deposit detection | user-submitted hash + screenshot | chain watchers, confirmation thresholds, reorg-safe |
| Balance | implied by transaction rows | double-entry ledger, per-asset + NGN |
| Key custody | none (addresses are external) | BIP-32 HD tree, seed sealed in an isolated signer service |
| Sweeping | manual | automated, gas-funded, admin-triggerable per-wallet or in bulk |
| Payout | manual approve → Paystack | ledger-backed, reserved then committed, webhook-reconciled |

---

## 2. The one invariant that must not break

You described this as *"all wallets belong to admin"* — which is what custodial
means and is fine — but it has an accounting consequence that the whole design
turns on:

> **Sweeping coins out of a user's deposit address must never change what that
> user is owed.**

So the system keeps two completely separate planes:

**Custody plane** — *where the coins physically sit.*
Deposit addresses → hot wallet → master/cold wallet. Sweeping moves value
*between our own accounts*. It is an internal asset transfer.

**Liability plane** — *what we owe each user.*
A double-entry ledger. A user's balance lives here and only here. It moves when
they deposit, sell, or withdraw — never when we sweep.

If these two are ever conflated (e.g. "balance = on-chain balance of the user's
address"), then emptying a wallet to master silently zeroes a customer's money.
Every read path for user balances hits the ledger, never a chain RPC.

The chain is the source of truth for *custody*. The ledger is the source of truth
for *liability*. A daily reconciliation job asserts:

```
Σ(on-chain custody balances) ≥ Σ(user crypto liabilities)   per asset
Σ(Paystack float + settlement bank) ≥ Σ(user NGN liabilities)
```

Any drift pages an operator and freezes withdrawals for the affected asset.

---

## 3. Service topology

```
                    ┌─────────────────────────────────────┐
   Expo app ───────▶│  api          (axum, public)        │
   Next.js admin ──▶│  admin-api    (axum, IP-allowlisted)│
                    └──────────────┬──────────────────────┘
                                   │
                    ┌──────────────▼──────────────────────┐
                    │  PostgreSQL 16  (ledger, wallets)   │
                    │  Redis          (quotes, OTP, locks)│
                    └──────────────┬──────────────────────┘
                                   │
        ┌──────────────┬───────────┼───────────┬────────────────┐
        │              │           │           │                │
   ┌────▼────┐   ┌─────▼────┐ ┌────▼────┐ ┌────▼────┐   ┌───────▼──────┐
   │watcher  │   │ sweeper  │ │ payout  │ │  rates  │   │   signer     │
   │per chain│   │ + gas    │ │ paystack│ │coingecko│   │ ISOLATED     │
   └─────────┘   └──────────┘ └─────────┘ └─────────┘   │ holds seed   │
                                                         └──────────────┘
```

Seven binaries in one Cargo workspace. `signer` is the only process that can
derive a private key, and it runs on its own host with no inbound internet route
— only mTLS from `sweeper` and `payout`. Compromising the API does not lose funds.

---

## 4. Key custody

### Derivation

One BIP-39 master seed → per-chain BIP-32/SLIP-10 trees. The user's numeric id is
the address index, so an address is always re-derivable and nothing needs backing
up per-user.

| Chain | Path | Curve | Address format |
|---|---|---|---|
| Bitcoin | `m/84'/0'/0'/0/{i}` | secp256k1 | bech32 (P2WPKH) |
| EVM (all) | `m/44'/60'/0'/0/{i}` | secp256k1 | one address, every EVM chain |
| TRON | `m/44'/195'/0'/0/{i}` | secp256k1 | base58check |
| Solana | `m/44'/501'/{i}'/0'` | ed25519 | base58 (SLIP-10, hardened only) |

`i = user.address_index`, a monotonic `BIGINT` assigned at signup. Postgres stores
only the **public** address and the index. No private key or xpriv is ever written
to the database, in any form, encrypted or not.

### Sealing the seed

The seed is a 32-byte entropy blob, encrypted under a cloud KMS key (AWS KMS /
GCP KMS) with an operator-held second factor. `signer` fetches and decrypts it at
boot into `mlock`ed, `Zeroizing<[u8;32]>` memory. Requirements on that process:

- core dumps disabled, swap off, no debugger attach (`PR_SET_DUMPABLE=0`)
- no logging crate linked that could reach the seed
- signing is request/response over mTLS: *"sign this exact tx for index N"* — it
  never returns key material
- every signature request is written to the append-only audit log **before** signing

The seed's paper/steel backup lives offline, split with Shamir 2-of-3 across
separate custodians. Recovery of the whole platform is 12 words plus this repo.

> **Master/cold wallet withdrawals require dual control**: two admin approvals
> plus a hardware key. That path is deliberately not automatable.

---

## 5. Data model (PostgreSQL)

Money is `NUMERIC` — never floats. Crypto `NUMERIC(38,18)`, NGN `NUMERIC(20,4)`.

```sql
users(id, phone, email, address_index BIGSERIAL UNIQUE, pin_hash, kyc_tier,
      status, created_at)

-- one user, many ways to sign in (§10.1)
identities(id, user_id, provider, subject, email, phone, verified_at,
           UNIQUE(provider, subject))

kyc_verifications(id, user_id, target_tier, provider, provider_reference,
                  status, bvn_last4, full_name, dob, rejection_reason,
                  reviewed_by, created_at)

wallets(id, user_id, chain, address, derivation_path, created_at)
        UNIQUE(chain, address), UNIQUE(user_id, chain)

-- double-entry: every transfer writes ≥2 rows summing to zero
ledger_accounts(id, kind, user_id NULL, asset, ...)
  kind ∈ { user_crypto, user_ngn,                 -- LIABILITY (we owe)
           custody_onchain, ngn_float,            -- ASSET (we hold)
           spread_revenue, fee_revenue,           -- REVENUE
           gas_expense, payout_fee_expense }      -- EXPENSE

ledger_entries(id, journal_id, account_id, asset, amount NUMERIC(38,18), created_at)
ledger_journals(id, kind, reference, idempotency_key UNIQUE, metadata JSONB, created_at)

  CONSTRAINT: per journal_id, per asset, SUM(amount) = 0   -- enforced by trigger

deposits(id, user_id, chain, asset, tx_hash, log_index, amount, confirmations,
         status, credited_journal_id, UNIQUE(chain, tx_hash, log_index))

sweeps(id, wallet_id, asset, amount, gas_funding_tx, sweep_tx, status,
       initiated_by, created_at)

quotes(id, user_id, asset, amount, rate, ngn_value, expires_at, consumed_at)

payouts(id, user_id, bank_account_id, amount_ngn, status, paystack_reference
        UNIQUE, paystack_transfer_code, reserved_journal_id, settled_journal_id)

bank_accounts(id, user_id, bank_code, account_number, account_name, verified_at)

audit_log(id, actor_type, actor_id, action, target, before JSONB, after JSONB,
          prev_hash, hash, created_at)   -- hash-chained, append-only
```

`ledger_entries` is append-only; corrections are reversing journals, never
UPDATE/DELETE. A user's balance is `SUM(amount)` over their account — always
derivable, always auditable, with a materialized cache for read speed.

### Worked example: user deposits 100 USDT-TRC20, sells, withdraws ₦150,000

```
J1  deposit credited (2 confirmations)
      custody_onchain:USDT        +100
      user_crypto:{u}:USDT        -100      (liability grows; sign convention: liabilities negative)

J2  sweep to master  ── NO LIABILITY MOVEMENT, custody sub-accounts only
      custody_hot:USDT            +100
      custody_deposit_addrs:USDT  -100
      gas_expense:TRX             +2.7      offset by custody_hot:TRX -2.7

J3  user sells 100 USDT @ ₦1,530 (mid ₦1,550, 1.3% spread)
      user_crypto:{u}:USDT       +100
      user_ngn:{u}               -153,000
      custody_onchain:USDT       -100
      spread_revenue:NGN          +2,000

J4  payout reserved (funds locked the instant the user taps withdraw)
      user_ngn:{u}               +150,000
      ngn_payable_pending        -150,000

J5  Paystack webhook: transfer.success
      ngn_payable_pending       +150,000
      ngn_float                 -150,000
      payout_fee_expense            +10     offset ngn_float -10
```

If Paystack fails, J5 is replaced by a reversal of J4 and the user's balance is
restored. There is no window in which the money is in neither place.

---

## 6. Deposit pipeline

Per chain, a `watcher` task:

1. tails new blocks from the head (websocket where available, else 3s poll)
2. matches transfers against `wallets.address` (in-memory bloom filter + PG lookup)
3. inserts `deposits` row, idempotent on `(chain, tx_hash, log_index)`
4. tracks confirmations; credits the ledger only at threshold
5. handles reorgs: if a credited tx disappears from the canonical chain, write a
   reversing journal and flag the account

**Confirmation thresholds:** BTC 2 · EVM 12 (Ethereum) / 20 (BSC, Polygon) /
10 (Base) · TRON 20 (solid block) · Solana finalized commitment.

A cursor table per chain makes the watcher crash-safe: restart resumes from the
last fully-processed block, and reprocessing is harmless because step 3 is
idempotent.

---

## 7. Sweeping

Triggered automatically when a deposit address exceeds a per-asset threshold, or
on demand from the admin panel (single wallet, filtered selection, or all).

Account-based chains need gas in the deposit address before it can send, so a
sweep is two transactions:

```
gas station → deposit address   (fund exact estimated fee)
deposit address → hot wallet    (send full token balance)
```

- **TRON** — TRX for bandwidth/energy; stake TRX for free energy to cut cost, else
  ~2-3 TRX per TRC-20 sweep
- **EVM** — native gas per chain; EIP-1559 with a capped `maxFeePerGas`
- **Solana** — fee payer can be the gas station directly (no pre-funding round
  trip); create the destination ATA if missing; respect rent exemption
- **Bitcoin** — no gas step; consolidate UTXOs, fee from the input, RBF enabled

Each sweep is a state machine (`pending → gas_funded → broadcast → confirmed`)
persisted in `sweeps`, so a crash mid-sweep resumes rather than double-spending.
Sweeps write **only custody-plane** journals (see J2 above).

Hot wallet keeps a float band (e.g. 10% of liabilities); the excess auto-forwards
to the master/cold wallet on a schedule.

---

## 8. Payouts (Paystack)

The NGN float pool is a real Paystack balance. Flow:

1. user picks amount + saved bank account → PIN or biometric re-auth
2. **reserve**: journal J4 above, inside one Postgres transaction with a
   row-level lock on the user's NGN account — this is what prevents double-spend
   under concurrent requests
3. `payouts` row gets a UUID `reference`; that UUID is the Paystack idempotency
   key, so a retry can never pay twice
4. call Paystack Transfer; store `transfer_code`
5. webhook `transfer.success` → J5; `transfer.failed`/`reversed` → reverse J4 and
   notify the user
6. a sweeper job re-polls any payout stuck > 15 min via
   `GET /transfer/verify/{reference}` — webhooks are treated as an optimization,
   never as the only path to truth

Guards: per-user daily and per-transaction caps by KYC tier, velocity checks,
name-match between the bank account and the KYC name, and a manual-review queue
above a configurable threshold. Float below a watermark alerts ops and queues
payouts rather than failing them.

---

## 9. Rates and spread

`rates` polls CoinGecko (plus a second source for sanity-checking; a >2%
divergence freezes quoting rather than guessing) and caches per asset in Redis.

Users transact against a **locked quote**, not a live rate: tapping "Sell" issues
a `quotes` row valid for 60 seconds at `mid × (1 - spread)`. The spread is set per
asset in the admin panel and is where the business earns. Quote consumption is
atomic — one quote, one trade.

---

## 10. Auth

Signup is one screen and no forms. **KYC is not part of it** — see §10.3.

```
┌──────────────────────────────┐
│  Phone number or email       │
│  [ 0801 234 5678          ]  │  → 6-digit code, by SMS or mail
│  [ Continue →             ]  │
└──────────────────────────────┘
        ↓
   set 6-digit PIN + enable biometrics
        ↓
   wallets derived, app usable, ₦0 balance
```

**One field, two channels.** The user types a phone number or an email and the
system decides which it got. The discriminator is `@`, checked before anything
else: a string containing one is never a phone number, and treating
`0801…@gmail.com` as a phone would send an SMS into the void. Parsing lives in
`crates/auth/src/identifier.rs` and is mirrored in `src/services/authV2.ts` — the
client picks the keyboard, the server picks the transport, and a disagreement
between them is a code delivered nowhere.

The code itself is identical either way: 6 digits, Argon2-hashed at rest,
10-minute TTL, 5 attempts, 60-second resend, rate-limited per destination *and*
per IP. SMS goes via Termii (best NG deliverability), email via Resend. The
channel is stored on the challenge rather than re-derived, so a resend cannot
pick a different transport from the original send.

> **There is no OAuth.** An earlier revision offered Google and Apple sign-in.
> Removing it deleted the per-platform client-id configuration, the JWKS
> fetching and nonce handling, and — because App Store Guideline 4.8 only binds
> apps offering a *third-party* social login — the obligation to implement Sign
> in with Apple as well. The OIDC verifier is recoverable from git history if
> that decision is ever revisited.

### 10.1 Identity linking

One user, two ways to prove who they are. This is the part that quietly breaks
custodial systems: if a user signs up by phone in January and by email in March,
a naive implementation gives them **two accounts and two sets of wallets**, and
the deposit they make against the second one is invisible from the first.

```sql
identities(id, user_id, provider, subject, verified_at, UNIQUE(provider, subject))
  provider ∈ { phone, email }
```

A `users` row can own several `identities`. On every sign-in:

1. exact match on `(provider, subject)` → that user, done
2. else, if the incoming identity carries a **verified** email or phone that
   matches an existing verified identity → attach to that user
3. else → new user, provision wallets

Rule 2 only ever fires on a *verified* channel. Matching on an unverified email
would let anyone claim another person's account and their balance by signing up
with the same address.

Linking a second identity to an existing account from inside the app requires
re-auth. Users can never *unlink* their last remaining identity — that would
orphan the account and the funds in it.

### 10.2 Sessions

Access JWT (15 min, EdDSA) + refresh token (30 days, rotating, bound to a device
id, reuse-detection revokes the whole family). Stored in `expo-secure-store`
(Keychain/Keystore). Biometrics gate app open; the PIN re-authorises withdrawals
above a threshold and adding a bank account. No password exists anywhere in the
system, so there is no password to phish, reuse, or leak.

### 10.3 KYC comes later, and is gated on *withdrawal*, not signup

A new user can sign up, get wallets, deposit crypto, watch their naira balance,
and explore the whole app at **Tier 0 with no KYC at all**. The wall goes up at
the point where value leaves the platform into the banking system, which is where
the AML obligation actually attaches.

| Tier | Requires | Can do | Daily payout cap |
|---|---|---|---|
| **0** | nothing — signup only | deposit, hold, see balance, sell to NGN | **cannot withdraw** |
| **1** | BVN + name/DOB match | withdraw to a bank account in their own name | ₦50,000 |
| **2** | Tier 1 + NIN + selfie liveness | — | ₦500,000 |
| **3** | Tier 2 + proof of address | — | ₦5,000,000 |

Deliberate consequences of this shape:

- **Nothing blocks the first session.** The user reaches a funded wallet before
  being asked for a single document, which is where signup funnels normally die.
- **Selling to NGN is Tier 0.** It moves value inside our own ledger and creates
  no external obligation, so there is no reason to gate it.
- **The KYC prompt appears in context** — the first time they tap Withdraw, with
  the reason stated — not as an interstitial wall during onboarding.
- **The bank account name must match the KYC name.** A verified identity paying
  out to a stranger's account is the single most common laundering pattern, and
  Paystack account-resolution returns the name to compare against.

Providers are Nigerian and behind a `KycProvider` trait so the choice is
reversible: **Dojah** or **Smile ID** for BVN/NIN lookup and liveness, with
Paystack's own BVN resolution as fallback. Verification is async — a user submits,
keeps using the app at their current tier, and is notified on approval. A failed
check goes to an admin review queue rather than a dead end.

> Tier 0 accepting deposits is a deliberate risk decision, not an oversight:
> inbound crypto from an un-KYC'd user is a sanctions-screening problem. The
> mitigation is address screening on deposit (Chainalysis/TRM) plus the hard
> withdrawal block, so tainted funds can arrive but cannot leave.

### 10.4 Admin auth

Entirely separate from user auth — no shared tokens, no shared table. Email +
mandatory TOTP, IP allowlist, 30-minute sessions, RBAC (`viewer` / `operator` /
`treasury` / `superadmin`), and every mutating action lands in the hash-chained
`audit_log`.

---

## 11. Admin panel (Next.js, extending the existing one)

- **Treasury** — aggregate holdings per asset, hot vs master split, NGN float,
  total user liability, and the live reconciliation delta
- **Wallets** — every user wallet with live on-chain balance, filterable by asset
  and minimum balance; sweep one, sweep selected, or sweep all above threshold
- **Users** — profile, KYC tier, balances, freeze/unfreeze
- **Deposits / Payouts** — full history, stuck-payout retry, manual review queue
- **Rates** — per-asset spread, pause trading per asset
- **Audit** — the append-only log, exportable

Bulk sweeps run as a background job with per-wallet progress, not a blocking
request.

---

## 12. Security posture

- private keys exist only inside `signer`; the API host cannot derive them
- ledger is append-only; balances are derived, never mutated in place
- all money paths are idempotent, keyed on a client-supplied or server-issued UUID
- withdrawals: PIN + velocity limits + tier caps + optional manual review
- admin: TOTP + IP allowlist + RBAC + dual control on master movements
- `#![forbid(unsafe_code)]` in every crate except where a vetted dep requires it
- `cargo deny` + `cargo audit` in CI; pinned dependencies
- secrets from KMS/Secrets Manager at boot — never in `.env` in production
- Postgres: TLS required, least-privilege roles, PITR backups, encrypted at rest

---

## 13. Build order

| Phase | Deliverable |
|---|---|
| 1 | Workspace, migrations, ledger core + invariant tests, `signer` + derivation (all 4 chains) with BIP-39 test vectors |
| 2 | Auth: phone + email OTP, identity linking, PIN, JWT sessions with rotating refresh, user + wallet provisioning, balance reads |
| 3 | Watchers: TRON + EVM (covers ~90% of NG volume), deposit crediting, reorg handling |
| 4 | Rates + quotes + sell flow |
| 5 | KYC tiers + provider integration, then payouts + Paystack + webhooks + reconciliation |
| 6 | Sweeper + gas station + admin treasury/wallets pages |
| 7 | BTC + Solana watchers and sweeps |
| 8 | Expo app rewritten against the new API |

Phases 1–2 land before anything touches real money; phase 5 is the first point at
which the system can move customer funds and should not ship without the
reconciliation job from §2 running green.

---

## 14. Two things to settle outside the code

**Regulatory.** Holding customer crypto and naira makes this a custodial VASP.
In Nigeria that engages the SEC's Rules on Digital Asset issuance and custody
(VASP registration), CBN guidance on banks servicing VASPs, and AML/CFT
obligations — KYC tiers, sanctions screening, suspicious-transaction reporting.
It also matters that Paystack's terms restrict crypto-related processing; a
payout provider that closes the account mid-operation strands customer funds, so
this needs confirming with them directly and a second provider (Flutterwave,
Anchor) wired as fallback. This doesn't change the architecture — the design
above already assumes KYC tiers and a swappable payout provider — but the licence
question should be answered in parallel with the build, not after.

**Insurance and the float.** Custody means a hot-wallet compromise is your loss,
not the user's. The hot/cold split in §7 caps that exposure; decide the band
deliberately.
