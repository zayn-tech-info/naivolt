# Production cutover checklist (`feat/virtual-number-baseline` → `main`)

Do **not** merge to `main` or run SQL against live Postgres until a human
explicitly says to. This file is the runbook. Secrets stay in the host secret
store; never paste them into chat or agent logs.

Operator TOTP recovery (spec 0007) is **out** of this cut.

## 0. What this cut contains

API PR vehicle to `main`: [naivolt #3](https://github.com/zayn-tech-info/naivolt/pull/3)
(`feat/virtual-number-baseline`). Website: merge the same branch name after the API is live.

Review-fix commits are already on `feat` (API [PR #9](https://github.com/zayn-tech-info/naivolt/pull/9),
website [PR #9](https://github.com/zayn-tech-info/naivolt-website/pull/9)):

- SMS in the inbox + closed/expired → `review_required`, never a silent refund
- Unknown 5SIM status stays Open
- SMSPool check/cancel does not fall back to the primary adapter
- Catalogue buy with live Paystack + stub primary → 503
- Website: no post-buy GET; one list poll; shared status labels

## 1. Backup (plan 16.12)

On the **production** Postgres host (not the unrelated Neon project `sochestral`):

```bash
# Snapshot / PITR first. Then, if using Neon for Naivolt prod:
# create a branch from the production parent and dry-run there.
# Example (replace project/branch ids — do not use this agent’s Neon org by default):
#   neon branches create --project-id <prod> --name cutover-dry-run-$(date -u +%Y%m%d)
```

Keep the snapshot until `_sqlx_migrations` on live includes 14–17, 19, 20 and
traffic is healthy.

## 2. Copy-DB migrate dry-run

Equivalent of what was proven on a throwaway main-schema copy (see
`/opt/cursor/artifacts/prod_migrate_dry_run.log` on the agent):

```bash
cd backend-rs
# DATABASE_URL must be the COPY, never live.
sqlx migrate run --source migrations
psql "$DATABASE_URL" -c "SELECT version, description, success FROM _sqlx_migrations ORDER BY version;"
psql "$DATABASE_URL" -f migrations/tests/number_order_invariants.sql
```

Expected versions: **1–13 (already on main), then 14, 15, 16, 17, 19, 20**.
**Must not** include **18**. `sqlx::migrate!("../../migrations")` does not read
`migrations/staged/`. Do not copy `0018_close_number_reconciliation.sql` into
`migrations/`.

If **0014** raises `number order migration blocked: missing reservation journals=…`
(or malformed keys / invalid journals): repair or archive those `number_orders`
on the **copy** first. Do not force 0014 on live.

0014 then 0015 in the same boot is intended: 0014 adds nullable `idempotency_key`
and backfills; 0015 requires NOT NULL. Do not invent an 0018-style staging split
for that.

**Do not** run `cargo run -p naivolt-devtools --bin seed` on production. Offers
come from live catalogue sync after keys are set.

## 3. Production env (`APP_ENV=production`)

Boot refuses without (see `config.rs` `validate_for_environment`):

| Variable | Rule |
| --- | --- |
| `JWT_SECRET` | ≥ 32 bytes |
| `SIGNER_URL` | set; **no** `DEV_MNEMONIC` |
| `DEV_OTP_CODE` | unset |
| `DEV_AUTO_APPROVE_KYC` | unset / false |
| `TERMII_API_KEY` | set |
| `RESEND_API_KEY` | set |
| `OPERATIONS_ALERT_EMAIL` | set (also required whenever `FIVESIM_API_KEY` is set) |
| `PAYSTACK_SECRET_KEY` | live only after 16.9 / 16.11 approval; staging keeps **test** keys |
| `FIVESIM_API_KEY` | **required even if SMSPool is the main supplier** — do not weaken this gate |
| `WEB_APP_URL` | `https://www.naivolt.com` (not localhost) |

CORS: production default is **only** `https://www.naivolt.com`. Do not set
`CORS_ALLOWED_ORIGINS` to `*` or a Vercel preview host. If you set the override,
it must still include `https://www.naivolt.com`.

Also set (not all hard-fail at boot, but required for this product):

- `DATABASE_URL` (prod Postgres)
- `SMSPOOL_API_KEY` / `SMSPOOL_CURRENCY` if you sell SMSPool SKUs
- `FIVESIM_CURRENCY` from the live 5SIM account
- `NUMBERS_MARGIN`, `USD_NGN_MID` (approved commercial values)
- `GOOGLE_CLIENT_ID` (API)
- `GOOGLE_ALLOWED_EMAILS` empty (public) or a launch cohort
- `ADMIN_TOKEN` (≥ 24 chars) if operators use the admin HTTP API
- Watcher / reconciler process with the same `DATABASE_URL`

Website:

- `VITE_API_URL=https://api.naivolt.com`
- `VITE_GOOGLE_CLIENT_ID` matching the API client

## 4. Deploy order (after backup + dry-run + env)

1. Merge `feat/virtual-number-baseline` → `main` on **API first** (PR #3).
2. Deploy the API so migrations apply on boot, **or** `sqlx migrate run --source migrations` immediately before traffic.
3. Confirm live `_sqlx_migrations` is 14–17, 19, 20; **not** 18.
4. Merge website `feat` → `main` and deploy with `VITE_API_URL=https://api.naivolt.com`.
5. Confirm a catalogue sync ran (`number_offers` non-empty; customer JSON has **no** supplier names).
6. Smoke **without** a paid live buy unless 16.11 is approved: Google sign-in, list offers. Paystack **test** only on staging. First live buy waits on 16.11 budget and a watching operator.
7. If funding is live and the number **primary** is still stub, keep numbers off sale (503). Catalogue buy is also 503 in that case even when SMSPool is configured.

## 5. Explicit non-goals for this cut

- Apply staged `0018`
- Seed production
- Live paid 5SIM/SMSPool certification (16.11)
- Merge 0007 ops (API PR #8, website PRs #6/#7)
- Deploy while `WEB_APP_URL` / CORS is not `https://www.naivolt.com`
