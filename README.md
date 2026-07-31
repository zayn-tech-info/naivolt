# Naivolt

> Custodial crypto-to-naira exchange for the Nigerian market. Users deposit crypto
> to a permanent address that stays theirs, watch it in naira, and withdraw to
> their bank account.

---

## Contents

1. [How it works](#how-it-works)
2. [Repository layout](#repository-layout)
3. [The invariant everything rests on](#the-invariant-everything-rests-on)
4. [Getting started](#getting-started)
5. [Environment variables](#environment-variables)
6. [Testing](#testing)
7. [Build commands](#build-commands)
8. [Status](#status)
9. [Before this touches real money](#before-this-touches-real-money)

---

## How it works

**Signup is one tap.** Google, Apple, or a phone number and a 6-digit SMS code.
No name, no username, no password — passwordless means there is nothing to
phish, reuse, or leak. A 6-digit PIN is set once and authorises withdrawals.

**Wallets are created automatically.** Every user gets a permanent deposit
address on Bitcoin, EVM (Ethereum/BSC/Polygon/Base), TRON and Solana, derived
from one master seed at that user's address index. Users never receive private
keys or a recovery phrase — this is a custodial service, and the keys exist only
inside an isolated signer process.

**KYC comes after signup, not before.** A new user can deposit, hold, see their
naira balance and sell, all at Tier 0 with no verification at all. The wall goes
up at withdrawal, where value leaves into the banking system and the AML
obligation actually attaches — and the prompt appears in context, the first time
someone taps Withdraw.

| Tier | Requires | Daily payout cap |
|---|---|---|
| 0 | signup only | **cannot withdraw** |
| 1 | BVN + name match | ₦50,000 |
| 2 | + NIN + selfie liveness | ₦500,000 |
| 3 | + proof of address | ₦5,000,000 |

**Payouts come from a float pool** at the payout provider — reserved in the
ledger the instant a user taps withdraw, settled on the provider's webhook, and
reversed if it fails. There is no window where the money is in neither place.

Full design in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**; the HTTP surface
between the core and the app in **[docs/API-CONTRACT.md](docs/API-CONTRACT.md)**.

---

## Repository layout

```
src/            Expo / React Native app (TypeScript)
  app/            expo-router routes
  components/     UI library — see components/ui/index.ts
  design/         tokens, typography, theming
  services/v2/    typed client for the Rust core

backend-rs/     Rust core (cargo workspace)
  crates/core       chains, assets, derivation paths, confirmations
  crates/wallet     BIP-39 seed handling, HD derivation (4 chains)
  crates/ledger     double-entry journals and balance invariants
  crates/auth       OIDC, phone OTP, identity linking, PIN, KYC tiers
  crates/devtools   local seeding — never deployed
  migrations/       SQL schema plus its own invariant tests

admin/          Next.js admin panel
docs/           architecture and API contract
```

**v1 is gone.** The Express/Mongo backend, its manual settlement model — upload a
screenshot, wait for an admin to verify — and its shared address pool were
removed in `85bafc4`. They remain in history at `15dab29` for reference. Gift
cards/Prestmit, Cloudinary uploads and push notifications are not yet ported.

---

## The invariant everything rests on

> **Sweeping a user's deposit address to the master wallet must never change what
> that user is owed.**

The system keeps two separate planes. The **custody plane** tracks where coins
physically sit — deposit addresses, hot wallet, master wallet — and sweeping
moves value between *our own* accounts. The **liability plane** is a double-entry
ledger recording what we owe each user, and it is the only thing user balances
are ever read from.

Conflate the two — say, by treating a balance as the on-chain balance of a user's
address — and emptying a wallet silently zeroes a customer's money.

This is enforced, not merely documented. A `Sweep` or `GasSpend` journal that
touches a liability account **fails to build**, and the schema rejects a custody
account carrying a `user_id`.

Two more rules hold the rest together:

- **Derivation is frozen.** Golden vectors pin the addresses produced for the
  standard BIP-39 test mnemonic. If that test fails, a change has moved every
  user's deposit address and orphaned funds already sent to the old ones.
- **Accounts link only on verified channels.** A new sign-in method attaches to
  an existing user only when the provider attested the email or phone. Linking on
  an unverified address is account takeover.

---

## Getting started

### Mobile app

```sh
npm install
npx expo start
```

### Rust core

```sh
cd backend-rs
cargo test --workspace          # no database needed

createdb naivolt_dev
for f in migrations/0*.sql; do psql -v ON_ERROR_STOP=1 -d naivolt_dev -f "$f"; done
```

### Test accounts

```sh
DATABASE_URL=postgres://localhost/naivolt_dev cargo run -p naivolt-devtools --bin seed
```

Seeds two logins, both with **OTP `000000`** and **PIN `428193`**:

| Account | Signs in with | Tier | Balance |
|---|---|---|---|
| `+2348000000001` | phone OTP | 0 — cannot withdraw | 250 USDT |
| `ada@example.com` | Google | 1 — ₦50k/day | 100 USDT + ₦45,000 |

The seeder runs through the real resolver, hashers, derivation and journal
builder, so a clean run is evidence the stack works — not just that rows exist.
It **refuses to run against anything non-local**: those wallets come from the
public BIP-39 test mnemonic and are spendable by anyone on the internet.

---

## Environment variables

### Mobile (`.env`)

```sh
EXPO_PUBLIC_API_URL=http://localhost:5000

# Google sign-in. Without these the button reports it isn't configured
# rather than failing at the OAuth sheet.
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=
EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID=
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=
```

### Rust core

```sh
DATABASE_URL=postgres://localhost/naivolt_dev
REDIS_URL=redis://localhost:6379

PAYSTACK_SECRET_KEY=        # bank payouts
TERMII_API_KEY=             # SMS OTP
DOJAH_API_KEY=              # BVN / NIN / liveness
```

> The master seed is **never** an environment variable. It is KMS-wrapped and
> decrypted only inside the signer process, which has no inbound internet route.
> See ARCHITECTURE.md §4.

Never commit `.env` files. `backend-rs/target/` and every `.env*` are already
ignored.

---

## Testing

```sh
cd backend-rs
cargo test --workspace                                       # 82 tests
cargo clippy --workspace --all-targets
psql -d naivolt_dev -f migrations/tests/invariants.sql        # 10 assertions
psql -d naivolt_dev -f migrations/tests/auth_invariants.sql   # 11 assertions
```

```sh
npx tsc --noEmit
npx eslint src
npx expo export --platform ios     # verifies every route bundles
```

The SQL suites assert that illegal operations are *rejected*: unbalanced
journals, updates to ledger entries, a tier raised without an approved
verification, two users sharing one deposit address.

---

## Build commands

```sh
npx expo start --dev-client                              # dev server
eas build --profile development --platform android       # dev APK
eas build --profile production --platform android        # Play Store AAB
eas build --profile production --platform ios            # App Store IPA
npx expo install <package>                               # add a package
```

Rebuild the dev client only when adding a native package; ordinary code changes
reload automatically.

---

## Status

| | |
|---|---|
| Rust tests | 82 passing |
| SQL invariants | 21 passing |
| Clippy | clean |
| iOS bundle | exports clean |

Phases 1–2 of the build order in ARCHITECTURE.md §13 are done: ledger, key
derivation, auth. Chain watchers, sweeping and payouts (phases 3–7) are next.
Nothing before phase 5 can move customer funds.

---

## Before this touches real money

- [ ] `signer` split into its own binary on its own host; nothing else links
      `naivolt-wallet`
- [ ] Master seed generated air-gapped, KMS-wrapped, Shamir 2-of-3 offline backup
- [ ] TRON and Solana golden vectors confirmed in TronLink/Phantom (BTC and EVM
      already match published BIP-84/MetaMask vectors)
- [ ] Reconciliation green: on-chain custody ≥ user liabilities, per asset
- [ ] Apple Sign-In shipped alongside Google — App Store Guideline 4.8 rejects
      iOS builds offering a social login with no private equivalent
- [ ] Deposit address screening (Chainalysis/TRM) live before Tier 0 deposits open
- [ ] Payout provider confirmed in writing. Paystack's terms restrict
      crypto-related processing, and a provider that closes the account
      mid-operation strands customer funds — wire a second (Flutterwave, Anchor)
- [ ] SEC VASP registration and the AML/CFT programme answered in parallel with
      the build, not after it

---

*React Native + Expo · Rust + PostgreSQL · Target market: Nigeria · Android + iOS*
