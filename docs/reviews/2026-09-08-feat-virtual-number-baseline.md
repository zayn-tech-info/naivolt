# Review, feat/virtual-number-baseline, 2026-09-08

**Reviewed by**: Claude Opus 5 (author model not recorded; reviewed on a different model than wrote the code)
**Scope**: 29 files, branch vs `origin/main` (merge base `72a2a13b`)
**Verdict**: Blocked

## Summary

This branch lands three specs at once: the Naivolt offers API (0004), the activation/inbox lifecycle
with `activationOpen` and compound provider checks (0005), and the production HTTP boundary with an
explicit CORS allow list and `governor` rate limits (0006). The engineering standard is high in
places — the ledger `post()` race is genuinely fixed, `IsolatedDatabase` is excellent test
infrastructure, and every customer payload is asserted free of supplier names. All 111 API tests pass
against Postgres.

One money bug blocks merge: when a provider closes an activation whose inbox already holds a real SMS
that the adapter could not extract a code from, the order is refunded while the customer keeps the
readable code. I reproduced it. Beyond that, the 5SIM status map closes on any unrecognised status
(inventing a close the spec forbids), the per-provider `check_for` silently falls back to the wrong
supplier, the rate limiters never evict their keys, and the settle/refund concurrency proof exercises
a code path the production binary no longer reaches — the compiler reports it as dead.

Evidence: `/opt/cursor/artifacts/review-probes.log`, `/opt/cursor/artifacts/review-build-and-tests.log`.
Probes were run in a throwaway copy at `/tmp/review-probe`; the reviewed working tree is unmodified.

## Blockers

### 🔴 A closed activation refunds an order whose inbox already delivered the code, `backend-rs/crates/api/src/number_order_transitions.rs:230`

**Problem**: the refund gate in `apply_check` is "no *qualifying code*", not "no SMS". `qualifying`
(line 197) only matches `number_messages` rows with a non-empty `code` column. A stored message with
text but no extracted code therefore leaves `qualifying` as `None`, and the very next branch refunds
the order as soon as `check.lifecycle == Closed` or stored expiry passes. Spec 0005 **AC-12** gates
that refund on "supplier finish or expiry **with no SMS**", and **AC-7** says the SMS path must
"never refund".

Reproduced (probe in `/opt/cursor/artifacts/review-probes.log`): one `open` check carrying
`{text: "Your WhatsApp code is 483-921", code: None}`, then one `closed` check with no messages:

```
PROBE status=expired reason=Some("supplier_finished") refunds=1 settles=0 messages=1
      inbox_text=Some("Your WhatsApp code is 483-921")
```

The trigger is not hypothetical on either adapter. `parse_smspool_check`
(`number_smspool.rs:436`) builds exactly this shape whenever SMSPool returns `full_sms` without a
populated `sms` field, and 5SIM returns `code: null` for any message its own parser does not
recognise (`number_provider.rs:454` copies that field through verbatim).

**Why it matters**: `GET /numbers/orders/:id` returns the full message text (`number_routes.rs:1031`),
so the customer reads the code out of their own inbox, completes their verification, and is refunded
in full. Every such order is a free number: we pay the supplier cost and recognise no revenue. It
also fires on the plain expiry path in the reconciler, not just on cancel, so nobody has to try
anything clever to hit it.

**Suggested fix**: separate "nothing arrived" from "something arrived that we could not parse".
Refund only when the order has no `number_messages` rows at all, which is what AC-12 says. For a
closed activation that stored messages but never produced a qualifying code, the honest outcomes are
to settle (the customer received a usable SMS) or to route to `review_required` so an operator
decides — but not to refund silently. Whichever is chosen, add a test at the `apply_check` level for
"text-only message, then closed" and for "text-only message, then expiry", since neither is covered
today.

## Major

### 🟠 An unrecognised 5SIM status closes the activation, `backend-rs/crates/api/src/number_provider.rs:463`

**Problem**: the lifecycle expression reads

```rust
let lifecycle = if waiting && !closed { Open } else if closed || !waiting { Closed } else { Open };
```

`waiting` and `closed` are disjoint by construction, so the second arm's `!waiting` makes *everything
that is not `PENDING`/`RECEIVED`* closed, and the trailing `else { Open }` is unreachable. `status`
is `#[serde(default)]` (line 271), so a missing field deserialises to `""` and also closes. Probed:

```
PROBE 5sim status=None            -> lifecycle=Closed
PROBE 5sim status=Some("")        -> lifecycle=Closed
PROBE 5sim status=Some("RESERVED")-> lifecycle=Closed
```

Spec 0005 **AC-6** enumerates the closing statuses (`FINISHED`, `TIMEOUT`, `CANCELED`, `BANNED`) and
**AC-4** says "do not invent further availability"; the SMSPool half of the same spec (**AC-5**)
explicitly requires "unknown or missing status … keep open, backoff, do not invent close", and
`parse_smspool_check` gets that right. The 5SIM adapter does the opposite.

**Why it matters**: a single unrecognised status string — a 5SIM API addition, a partial response, a
proxy that strips the field — takes a live number out of service, stops the reconciler claiming it
(`activation_open` goes false), and, combined with the blocker above, refunds the order. The
unreachable `else { Open }` arm suggests the "keep open" fallback was intended and lost.

**Suggested fix**: close only on the enumerated terminal statuses; treat anything else (including
empty) as `Open` so the existing backoff handles it, mirroring the SMSPool branch. Make `status`
absence explicit rather than defaulting to `""`, and add a case to
`terminal_status_stores_final_sms_then_closes` for an unknown status staying open.

### 🟠 `check_for`/`cancel_for` fall back to the wrong supplier when the named one is unconfigured, `backend-rs/crates/api/src/number_provider.rs:228`

**Problem**: both methods route `"smspool"` to `self.smspool` and, when that is `None`, silently use
`self.primary` (lines 232 and 242) with the SMSPool order id. Orders carry the supplier that actually
sold the number in `number_orders.provider`, so any SMSPool order outliving its key — key rotated,
env var dropped during an incident, a rollback that omits `SMSPOOL_API_KEY` — gets checked against
5SIM instead.

**Why it matters**: both suppliers use short numeric order ids, so `GET /v1/user/check/{smspool_id}`
can plausibly resolve to a *different, real* 5SIM order of ours. Its SMS would then be inserted
against the wrong order and could settle it, showing one customer another customer's code. In
development the failure mode is cleaner but worse-looking: `primary` is `StubProvider`, whose
`check()` returns a hardcoded `123456` (line 591), so the order settles on a fabricated code.

**Suggested fix**: return `ApiError::ServiceUnavailable` when the order's named provider is not
configured, and let the existing reconciler backoff handle it. The same applies to `buy_source`'s
`"stub"` arm, which reaches `primary.buy` even when `primary` is live 5SIM.

### 🟠 Rate-limiter key stores grow without bound, `backend-rs/crates/api/src/boundary.rs:68`

**Problem**: eleven `RateLimiter::keyed` instances are created at boot and nothing ever calls
`retain_recent()` or `shrink_to_fit()`. `governor`'s `DefaultKeyedStateStore` is a `DashMap` that only
evicts when asked. Probed against `keyed(60)`:

```
PROBE limiter distinct keys retained = 50000
```

**Why it matters**: the key is `ip.to_string()` (line 214), and after `X-Real-IP` is honoured that is
the real client address. One IPv6 client owns a /64 and can rotate source addresses freely, so the
maps grow for the process lifetime across all eleven buckets. Spec 0006 accepts "in process limits
reset on restart" as a tradeoff, but not that the mitigation becomes the memory-exhaustion vector.
There is also no cap on distinct keys per bucket, so this is cheaper to exploit than the requests it
is meant to slow.

**Suggested fix**: call `retain_recent()` on each limiter from a periodic task (a minute is ample,
given per-minute quotas), or hold the limiters behind a bounded LRU keyed by IP. Worth asserting in a
test that key count stops growing after a sweep.

### 🟠 The settle/refund concurrency proof covers a path production no longer reaches, `backend-rs/crates/api/src/number_order_transitions.rs:13`

**Problem**: `cargo build -p naivolt-api` reports `OrderTransition::Deliver` never constructed and
`apply`, `deliver`, `deliver_claimed`, `check_from_legacy_deliver` never used (full list in
`/opt/cursor/artifacts/review-build-and-tests.log`). Production settles exclusively through
`apply_check` → `settle_open` (line 330); the ~150-line `apply_inner` (line 457) settle/refund
branch is now reachable only from tests.

`concurrent_terminal_transitions_commit_once` — the test that proves "exactly one terminal journal
under a delivery/refund race", including the injected trigger-failure and uncertain-ack cases —
drives `apply`, i.e. the dead branch. So the live settle has no concurrency test. The two
implementations have also drifted: `apply_inner` checks `rows_affected() != 1` and fails loudly
(line 612), while `settle_open` and `refund_open` do not check at all, so a zero-row update there
would commit a `NumberSettle` journal against an order row that never moved to `delivered`.

**Why it matters**: the strongest money test in the change is measuring code that ships dead, which
is worse than no test because it reads as coverage. Two copies of the settle and refund ledger
postings will drift again.

**Suggested fix**: delete `apply_inner`, `apply`, `deliver`, `deliver_claimed`,
`check_from_legacy_deliver`, and the `Deliver` variant, and re-point the concurrency, injected-failure
and uncertain-ack tests at `apply_check`. Carry the `rows_affected() != 1` guard into `settle_open`
and `refund_open` while doing so. If any of that code is deliberately kept for a later slice, say so
in a comment and mark it `#[allow(dead_code)]` so the build stays clean.

### 🟠 Migration 0015 closes the expand/contract window in the same release that opens it, `backend-rs/migrations/0015_require_number_order_identity.sql`

**Problem**: 0014 adds `number_orders.idempotency_key` as nullable and 0015 sets it `NOT NULL`, and
both sit in `migrations/` so `sqlx::migrate!` applies them in the same boot. `create_order` still
carries the transitional probe at `number_routes.rs:593`, which queries `pg_attribute.attnotnull` on
every purchase to decide between the legacy raw-UUID reservation key and the user-scoped one — and
whose own comment says "until the closing migration". `migrations/tests/closing_number_order_identity.sql`
confirms the column is `NOT NULL` after this cut, so that branch can never be taken again.

**Why it matters**: two consequences, both real. The probe is now a dead catalog round trip inside
the money path of every buy, plus dead code that reads as a live compatibility path. And the staging
discipline applied to 0018 (correctly held back) was not applied here: any previous-generation
process still serving during the deploy cannot insert a `number_orders` row at all, because it does
not populate `idempotency_key`, so every purchase 500s until it drains. If deploys are
stop-then-start on one host, only the dead-code half applies.

**Suggested fix**: pick one. Either move 0015 to `migrations/staged/` alongside 0018 and keep the
probe until a later release, or land 0015 and delete the probe and its legacy branch, replacing them
with the unconditional user-scoped key. Whichever way, the code and the applied migrations should
agree.

## Minor

### 🟡 Offer failover can outlive its own claim lease, `backend-rs/crates/api/src/number_routes.rs:671`

The failover loop walks every in-stock source for the offer with no cumulative deadline and no
`LIMIT` on the source query (line 483), while each supplier client allows 20s
(`number_provider.rs:295`, `number_smspool.rs:29`). The claim taken at line 658 lasts 60 seconds, so
four or more attempted sources can let it expire mid-purchase. The reconciler then claims the order,
sees `reserved` with `provider_purchase_started_at` set and no `provider_order_id`, and marks it
`review_required`; the winning purchase's assignment update then matches zero rows, cancels the
number at the supplier, and returns. No money is lost or duplicated, but the customer's naira stays
reserved until an operator intervenes. Cap the loop (a source count, or a deadline comfortably inside
the lease), or extend the lease before each attempt.

### 🟡 Cancel reports 409 "already received a message" after refunding the order, `backend-rs/crates/api/src/number_routes.rs:895`

The `!check.messages.is_empty()` arm calls `apply_check` and then unconditionally returns `Conflict`.
When those messages carry no code and the activation is closed, `apply_check` takes the refund branch,
so the customer is told their number cannot be cancelled while it was in fact cancelled and refunded.
Branch on the `TransitionOutcome` and return the loaded order when money actually moved. Fixing the
blocker changes which states reach here, so the two are best addressed together.

### 🟡 The 0016 message-key backfill puts wall clock in the identity, `backend-rs/migrations/0016_number_order_reconciliation.sql:38`

The backfill digests `m.received_at` for every legacy row, but legacy rows stored `received_at` as
insert-time `now()`, and the runtime insert (`number_order_transitions.rs:270`) deliberately omits the
timestamp when the supplier did not send one. Spec 0005 **AC-8** and invariant 9 forbid wall clock in
`provider_message_key` for exactly this reason. Consequence: for an order still open across the
deploy, re-polling the same message computes a different key and inserts a second inbox row. Staged
0018 repeats the same expression. Backfill with the timestamp-free digest when `received_at` was not
supplier-supplied, or accept the duplicate and note it.

### 🟡 Product resolution is non-deterministic, `backend-rs/crates/api/src/number_offers.rs:205`

`SELECT id FROM number_products WHERE active AND (slug = $1 OR provider_product = $1) LIMIT 1` has no
`ORDER BY`, so when one row matches on `slug` and a different row matches on `provider_product`,
which one wins is up to the planner. An SMSPool SKU could then attach its offer to an unrelated
product, and a customer buying that offer gets a number provisioned for a different service. Prefer
an exact `slug` match and fall back to `provider_product` only if nothing matched.

### 🟡 The offer sweep is neither transactional nor set-based, `backend-rs/crates/api/src/number_offers.rs:77`

`apply_provider_skus` issues two lookups plus two writes per SKU on the pool with no enclosing
transaction, so an error partway through leaves sources updated and the `number_offers`
quantity/active recompute (line 192) never run — offers advertising stock that no source still backs.
That recompute is also unscoped, rewriting every row in the table with two correlated subqueries on
every provider sweep. At current SMSPool volumes (roughly a dozen services × countries) this is
tolerable; it will not be once 5SIM SKUs carry success rates. Wrap the sweep in one transaction and
scope the recompute to the offers touched, or batch the SKUs through `UNNEST` as
`upsert_prices` already does.

### 🟡 `Retry-After` is unreadable from the browser, `backend-rs/crates/api/src/boundary.rs:98`

`CorsLayer` sets no `expose_headers`, so on a cross-origin call from `https://www.naivolt.com` to the
API host the `Retry-After` header that spec 0006 **AC-6** requires is invisible to JavaScript. Only
`meta.retryAfter` in the body is usable. The boundary test asserts the header on the raw response, so
it passes without proving the website can read it. Add `Retry-After` to `expose_headers`, or state in
the spec that the body field is the browser contract.

### 🟡 A wildcard origin panics at boot in development, `backend-rs/crates/api/src/config.rs:372`

`reject_public_origins` only runs for production and staging, so `CORS_ALLOWED_ORIGINS=*` passes
`Config::load` in development and then panics inside `AllowOrigin::list` (`boundary.rs:112`), which
rejects wildcards — after migrations have run and the workers have spawned. Reject `*` in every
environment so the failure is a config error rather than a crash loop.

### 🟡 Reserve journal metadata is empty on the offer path, `backend-rs/crates/api/src/number_routes.rs:622`

The metadata records `body.product_slug` and `body.country_code`, which are empty strings for every
`offerId` purchase. The audit trail on the new buy path is `{"product":"","country":""}`. Resolve the
slug and code from the offer row, or record `offer_id`.

### 🟡 A numeric SMSPool order id would make every purchase ambiguous, `backend-rs/crates/api/src/number_smspool.rs:232`

`orderid` and `order_id` are `Option<String>`, and `#[serde(default)]` only covers an absent field —
a present-but-numeric value fails deserialisation, which maps to `PurchaseError::Ambiguous` and
routes the order to `review_required` with the money still reserved. I could not confirm SMSPool's
actual response shape from here (no live paid buys in this environment), so this may be fine; but
`value_key` (line 256) already handles number-or-string ids elsewhere in the same file, and reusing
that tolerance costs nothing. The same applies to `phonenumber`/`number`.

### 🟡 The clippy step cannot fail, `.github/workflows/api-proof.yml:37`

`cargo clippy -p naivolt-api --all-targets` has no `-D warnings`, so the step always exits 0 and the
job is a test-only gate. The nine dead-code warnings behind the Major above would have been caught by
a failing lint. If clippy is intentionally advisory (commit `3f1f224` suggests so), consider at least
`-D dead_code`, which is the class that actually bit here.

## Nits

- ⚪ `backend-rs/crates/api/src/number_routes.rs:44`, `assignment_cancel_provider` is called only from its own test; the production cleanup at line 793 already uses the winning provider, so the test proves nothing about shipped behaviour. Delete both, or route the real call through the helper.
- ⚪ `backend-rs/crates/api/src/number_routes.rs:687`, `err.to_string().contains("out of stock")` re-implements `PurchaseError::is_out_of_stock` (itself dead) by matching on customer-facing copy — reword that sentence and failover silently stops working.
- ⚪ `backend-rs/crates/api/src/boundary.rs:164`, a missing `ConnectInfo` defaults the peer to `127.0.0.1`, which makes the peer look loopback and `X-Real-IP` trusted from anyone. `main.rs:252` does install the connect-info layer, so this is unreachable today; `IpAddr::UNSPECIFIED` would fail safe.
- ⚪ `backend-rs/crates/api/src/boundary.rs:94`, an unparseable origin is silently replaced with the production origin. Fail the boot instead — `Config::load` already validated the list.
- ⚪ `backend-rs/crates/api/src/config.rs:414`, `lower.contains("127.")` also rejects legitimate hosts such as `https://api127.example.com`. Parse the host and compare, rather than substring-matching.
- ⚪ `backend-rs/crates/api/src/number_routes.rs:152`, `quantity` is always serialised as a number; spec 0004 says omit or null when no source sent one. Harmless because the list filters `quantity > 0`, but the contract and the type disagree.
- ⚪ `backend-rs/crates/api/src/number_routes.rs:163`, a missing `product` query parameter yields axum's plain-text 400 rather than the `{code, message}` envelope every other failure uses.
- ⚪ `backend-rs/crates/api/src/number_reconciler.rs:125`, a delivered order that closes with no new messages still gets `cancel_for` called on it. Both suppliers should no-op, but cancelling an activation we already settled reads as a mistake.
- ⚪ `backend-rs/crates/api/src/number_provider.rs:694`, `five_sim_http_paths_never_include_finish` greps its own source with `include_str!`. It does enforce spec 0005 invariant 5, but it will pass just as happily if the call moves to another module.

## Strengths

- `crates/ledger/src/journal.rs:196` — the `post()` rewrite is the right fix. `INSERT … ON CONFLICT (idempotency_key) DO NOTHING RETURNING id` followed by a re-select closes the read-then-insert window that the old code left open, and the comment correctly explains why the second statement sees the committed row under READ COMMITTED. Speculative insertion also means an aborted competitor lets the insert through, so the `fetch_one` fallback cannot spuriously fail.
- `crates/api/src/payout_routes.rs:389` — same pattern applied to first-time NGN account creation, with `FOR UPDATE` on the fallback read so the caller still holds the lock it asked for, and an actual two-task concurrency test rather than an assertion about intent.
- `crates/api/src/test_database.rs` — per-test schema, advisory-locked `pgcrypto` install with a clear comment on why the search path forces it, and cleanup proven on both ordinary drop and panic. It also runs the `migrations/tests/*.sql` invariant suites in-process, so the schema-level checks are part of `cargo test` instead of a manual step.
- `crates/api/src/number_routes.rs:1953` — `json_hides_suppliers` is applied to the offer list, the catalogue, order list and detail, *and* error bodies. Spec 0004 AC-11 is the kind of requirement that rots silently, and this is the right way to pin it.
- `crates/api/src/boundary.rs:332` — the boundary tests cover every scenario spec 0006 AC-11 asks for, including preflight request headers, the named Vercel host, missing `Origin` reaching the handler, `X-Real-IP` bucketing per address, and the 30-request poll budget. Layer order is right too: CORS outermost, so a 429 still carries allow-origin and the browser can read the body.
- `migrations/0014` and `0015` — the pre-flight `DO` blocks that count malformed keys, unknown statuses and inconsistent financial states, and refuse to run rather than half-migrating, are exactly the right instinct for a money table.
- `migrations/0019_number_offers.sql` — the unique key is precisely spec 0004 AC-5's merge rule, `provider_operator` defaults to `''` so the four-column key works with nullable operators, and the partial index matches the list query's sort and predicate.

## Test coverage

**Signal**: configured (`test-preferences.json`, `cargo test`). The whole workspace passes against a
live Postgres: 111 API tests, 71 auth, 38 watcher, 15 ledger, 18 wallet, 3 core, 0 failures
(`/opt/cursor/artifacts/review-build-and-tests.log`).

**Well covered**: offer ranking, `recommended`, the exact low-success sentence, merge-vs-split on
success rate, stale-price rejection, out-of-stock omission and refresh error, camelCase wire shape,
supplier-name absence, ownership (stranger reads and cancels both 404), missing and forged bearer
tokens on all three private routes, the four cancel outcomes (SMS present, pending, provider check
failure, claim held), expiry with and without SMS, retry-then-settle, delivered-then-closed without
refund, message dedup with and without supplier timestamps, and all of spec 0006's boundary
scenarios.

**Gaps, in the order I would close them**:

1. No test drives a closed or expired activation whose only stored message has no code — the blocker. Both the reconciler expiry path and the cancel path need one.
2. No test for an unknown or missing 5SIM status. `terminal_status_stores_final_sms_then_closes` only walks the six known values, which is why the `!waiting → Closed` default went unnoticed.
3. The live settle path has no concurrency test. `concurrent_terminal_transitions_commit_once` covers `apply_inner`, which the production binary never calls; `apply_check`/`settle_open` are only exercised sequentially.
4. `create_order`'s offer failover — first source out of stock, second wins, order records the winning supplier — is untested. The only test in that area asserts an unused helper.
5. `apply_provider_skus` has no failure-atomicity test, which is where the non-transactional sweep would show up.
6. `check_for`/`cancel_for` with an unconfigured named provider is untested; a test asserting an error rather than a primary-provider fallback would have caught that Major.

Spec 0005 AC-10 (website polling cadence and label matrix) is not verifiable from this repo — those
files live in `naivolt-website`. The Expo app under `src/` does not call `/numbers/orders` at all, so
nothing here needs the new `cancellable` field yet.
