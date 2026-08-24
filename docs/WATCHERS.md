# Chain watchers

Watching four EVM networks and TRON for transfers into user deposit addresses,
crediting the ledger once the chain is deep enough to trust, and undoing the
credit if the chain later disagrees.

One supervised task per network, each independent: a rate-limited TronGrid must
not stop Base deposits from crediting, and a task that fails restarts rather than
taking the process down (ARCHITECTURE.md §6).

---

## 1. The money path

A deposit is the only journal that creates a liability out of nothing — the coins
arrive from outside the system:

```
credit    custody_deposit_addrs  +100    the coins are ours to hold
          user_crypto:{u}        -100    and we owe the user that much

reverse   custody_deposit_addrs  -100    they were never ours
          user_crypto:{u}        +100    and we never owed this
```

Three orderings carry the design.

**Confirmed before credited.** A transfer is recorded the moment it is seen and
credited only at the network's threshold — Ethereum 12, Base 10, BSC and Polygon
and TRON 20. The thresholds are set by reorg risk, not block time: BSC produces
blocks fast *and* reorgs deeper, so it waits for more, not less.

**A reversal is the credit with its signs flipped**, under a separate idempotency
key (`reversal:…` against `deposit:…`). Sharing the key would make the reversal a
replay of the credit, post nothing, and leave a user holding money that no longer
exists — which is why `a_reversal_does_not_collide_with_the_credit_it_undoes` is
a test and not a comment.

**Dust is ignored, not credited.** Below one USDT, 0.005 ETH, 0.0001 BTC, the gas
to sweep the deposit exceeds the deposit. Crediting it means paying to move money
we then owe.

## 2. Seeing a transfer twice is normal

Blocks are reprocessed constantly — on restart, after a narrowed window, and on
every pass through the overlap in §4 — so every write is idempotent. The natural
key is `(chain, tx_hash, output_index)`, never the hash alone: one transaction
can carry several deposits. Crediting is guarded twice over, by that key on the
journal and by a status check under `SELECT … FOR UPDATE` on the row.

```
seen → confirming → confirmed        the ordinary path
              ↘ ignored              dust, or a token we do not recognise
confirmed → reversed                 the chain changed its mind (§3)
```

A deposit is only credited from a contract listed in `token_contracts`. Without
that table anyone could deploy a token, call it USDT, transfer a billion of it to
a user's deposit address and have us book it as real money.

## 3. Reorgs: the block moved, the money did not

Detection is block-level and the decision is transaction-level, and the gap
between those two is where a user's money would otherwise go missing.

Every pass compares the hash we recorded against the hash the chain now reports
at that height. A mismatch means history was rewritten — but a reorg almost
always *re-includes* the same transactions in the replacement blocks. Reversing
on the mismatch alone would debit a user for a deposit that is still there, and
since a reversed deposit is never revisited, it would stay lost.

So a mismatch asks `eth_getTransactionReceipt` where the transaction is now:

| Receipt says | What happens |
|---|---|
| a different block | follow it — update the height, the credit stands |
| no receipt at all | the transaction is genuinely gone — reverse |
| the call failed | **nothing** — an RPC blip is not evidence of a missing deposit |

## 4. What the endpoints actually do

None of this was visible from the code; all of it came from a live run.

| Endpoint | Behaviour |
|---|---|
| `bsc-dataseed.binance.org` | refuses `eth_getLogs` at **every** range, single blocks included (`-32005 limit exceeded`) |
| `*.publicnode.com` | serves logs, but refuses a window reaching past the blocks it keeps: `Archive requests require a personal token` |
| `polygon-bor-rpc.publicnode.com` | refuses 2,000 blocks (`invalid block range params`), serves 1,000 |
| `polygon-rpc.com` | 403, tenant disabled |
| any pooled endpoint | answers from a node a block or two behind the one that just reported the head |
| TronGrid, unkeyed | 429 within seconds of a tight sweep |

Two mechanisms come out of that list.

**The window is discovered, not configured.** Log scans start at 2,000 blocks and
halve on every refusal, widening again on success. A provider that refuses even a
single block is not a range problem and cannot be fixed by asking for less, so
the watcher says exactly that and stops — the first run left BSC retrying a query
that could never succeed, restarting every ten seconds with its cursor pinned at
zero, and nothing in the logs said why.

**Each pass re-asks for the last few blocks.** A pooled endpoint that answers
from a lagging node returns *fewer* logs for a block rather than an error, and
the log scan passes each block exactly once — so without an overlap, a deposit in
that block is missed permanently. Overlapping costs one filtered query and
nothing else, because insertion is idempotent.

Failures are told apart before they are acted on: a rate limit backs off in
seconds and honours `Retry-After`, a refused range narrows the window instead of
burning three more retries on a query the node will never answer, and a head race
(`block range extends beyond current head block`) is simply asked again.

## 5. TRON is not an EVM chain with different addresses

TronGrid exposes no efficient by-block log filter, so TRON is polled per address
against `/v1/accounts/{addr}/transactions/trc20` — one request per address per
sweep, which is why the sweep is paced and why an API key matters.

**That endpoint returns no block height at all.** It reports a timestamp, and the
first version of this code derived a height from it — producing a number seven
times the real chain head, so every TRON deposit sat at zero confirmations and
none of them could ever be credited. The height now comes from
`wallet/gettransactioninfobyid`, one extra request per newly seen transfer, and
sweeps only look back to the previous sweep so that request is not repeated for
transfers already recorded.

Without `TRON_API_KEY` the sweep deliberately slows to one address per second
every fifteen seconds. It costs nothing: TRON waits 20 confirmations — a full
minute — before a deposit can be credited anyway.

## 6. Running it

```sh
set -a && . ./backend-rs/.env.local && set +a
DATABASE_URL=postgres://localhost/naivolt_dev cargo run -p naivolt-watcher
```

| Env | Missing means |
|---|---|
| `ETHEREUM_RPC_URL` `BSC_RPC_URL` `POLYGON_RPC_URL` `BASE_RPC_URL` | that network is not watched, and says so at boot |
| `TRON_RPC_URL` | TRON is not watched — the highest-volume rail in this market |
| `TRON_API_KEY` | TronGrid is polled slowly to stay inside the unkeyed IP limit |
| all of them | the process refuses to start rather than watching nothing |

Pick endpoints that serve `eth_getLogs`; §4's table is the shortlist. Verified
against mainnet by pointing a development wallet at a busy exchange address:
1,186 Base USDC transfers recorded — 1,153 credited, 24 still short of ten
confirmations, 9 ignored as dust — and 4 TRON USDT transfers credited at their
real heights. Every journal balanced, and no deposit was credited twice across
repeatedly overlapping scans.

## 7. Open

- **Native coins are not watched.** ETH, BNB, TRX, MATIC and BTC have rows in
  `token_contracts`, but the EVM scan reads `Transfer` logs and a native transfer
  emits none. A user who sends ETH to their deposit address is not credited and
  nothing reports it. Either scan block transactions for these or stop showing
  the addresses for them.
- **Bitcoin and Solana have no adapter** (build order §13 phase 7). The watcher
  refuses those networks explicitly rather than looping silently.
- **TRON reorgs are not detected.** TronGrid exposes no by-height block lookup on
  the endpoint in use, so §3 covers EVM only; 20 confirmations is the whole
  defence.
- **Per-address polling does not scale.** TRON costs one request per address per
  sweep — fine for hundreds of users, not for tens of thousands. The fix is a
  contract-event feed filtered to our addresses, which is what the EVM path
  already does.
- **A stalled network is only visible in logs.** There is no metric on cursor
  age, and a cursor that stops moving is exactly what a missed deposit looks
  like.
