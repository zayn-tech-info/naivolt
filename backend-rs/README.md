# naivolt-rs

Custodial wallet, ledger and payout core. Design: [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).

## Crates

| Crate | Purpose |
|---|---|
| `naivolt-core` | Chains, assets, derivation paths, confirmation thresholds |
| `naivolt-wallet` | BIP-39 seed handling and address derivation (BTC, EVM, TRON, Solana) |
| `naivolt-ledger` | Double-entry journals, accounts, balance invariants |
| `naivolt-auth` | Google/Apple OIDC, phone OTP, identity linking, PIN, KYC tiers |
| `naivolt-api` | HTTP surface: auth, wallets, quotes, virtual numbers, funding |
| `naivolt-watcher` | Chain watchers: deposit detection, confirmations, reorgs |
| `naivolt-devtools` | Local seeding. Never deployed (`publish = false`) |

## Running things

```sh
cargo test --workspace          # 190 tests, no database needed

# schema + its own invariant tests (25 assertions)
createdb naivolt_dev
for f in migrations/0*.sql; do psql -v ON_ERROR_STOP=1 -d naivolt_dev -f "$f"; done
psql -v ON_ERROR_STOP=1 -d naivolt_dev -f migrations/tests/invariants.sql
psql -v ON_ERROR_STOP=1 -d naivolt_dev -f migrations/tests/auth_invariants.sql
```

## Test accounts

```sh
DATABASE_URL=postgres://localhost/naivolt_dev cargo run -p naivolt-devtools --bin seed
```

Seeds two logins, both with **OTP `000000`** and **PIN `428193`**:

| Account | Signs in with | Tier | Balance |
|---|---|---|---|
| `+2348000000001` | phone OTP | 0 — cannot withdraw | 250 USDT |
| `ada@example.com` | Google | 1 — ₦50k/day | 100 USDT + ₦45,000 |

Re-running reuses the accounts instead of duplicating them, and the seeder goes
through the real resolver, hashers, derivation and journal builder — so a clean
run is evidence the stack works, not just that rows exist.

It **refuses to run against anything non-local.** The wallets come from the public
BIP-39 test mnemonic, so those deposit addresses are spendable by anyone on the
internet; seeding them into a real database would be handing users compromised
addresses. `localhost` is not sufficient on its own — a database named `*prod*` is
blocked too.

## The three rules

**1. Sweeping never changes what a user is owed.** Custody accounts
(`custody_deposit_addrs`, `custody_hot`, `custody_master`) track where coins
physically sit. Liability accounts (`user_crypto`, `user_ngn`) track what we owe.
A `Sweep` or `GasSpend` journal that touches a liability account fails to build —
see `journal::tests::sweep_cannot_touch_a_user_balance`.

**2. Derivation is frozen.** `address::tests::golden_vectors_are_frozen` pins the
addresses produced for the standard BIP-39 test mnemonic. If that test fails, a
change has moved every user's deposit address and orphaned funds already sent to
the old ones. Fix the change, not the test.

**3. Accounts link only on verified channels.** `identity::resolve` will attach a
new sign-in method to an existing user *only* when the provider attested the email
or phone. Linking on an unverified address means anyone who signs up with
`victim@gmail.com` inherits the victim's balance — see
`identity::tests::unverified_email_cannot_hijack_an_account`.

## Before this touches real money

- [ ] `signer` split into its own binary on its own host; nothing else links
      `naivolt-wallet`
- [ ] Master seed generated on an air-gapped machine, KMS-wrapped, Shamir 2-of-3
      offline backup
- [ ] TRON and Solana golden vectors independently confirmed in TronLink/Phantom
      (BTC and EVM already match published BIP-84/MetaMask vectors)
- [ ] Reconciliation job green: on-chain custody ≥ user liabilities, per asset
- [ ] Apple Sign-In implemented alongside Google — App Store Guideline 4.8 rejects
      iOS builds that offer a social login without a private equivalent
- [ ] Apple's first-authorization email persisted; it is never returned again
- [ ] KYC provider chosen (Dojah / Smile ID) and the `KycProvider` trait bound
- [ ] Deposit address screening (Chainalysis/TRM) live before Tier 0 deposits open
