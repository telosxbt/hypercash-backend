# HyperCash — Backend Indexer

Continuously indexes the shielded-pool events (`NewCommitment`, `NewNullifier`)
from HyperEVM into Postgres and serves a small HTTP API so the frontend pulls
all commitments/nullifiers in a few paged calls — instead of scanning
`eth_getLogs` in the browser on every load (which doesn't scale and hits the
public RPC's 1000-block range cap).

Stack: **Bun + TypeScript + ethers v5 + Postgres (porsager) + Hono**.

## Run locally

```bash
bun install
cp .env.example .env   # fill RPC_URL, DATABASE_URL, POOLS
bun run src/index.ts   # migrates DB, starts indexer loops, serves API
```

`bun test` runs the decode tests; set `TEST_DATABASE_URL` to also run the DB/range tests.

## How it works

- One independent loop per pool (a slow pool never blocks others). Each loop
  scans `eth_getLogs` in ≤999-block windows from the pool's `deployBlock` to
  `head - CONFIRMATIONS`, decodes the two events, and upserts.
- **Idempotent & restart-safe**: commitments keyed by `(pool, leaf_index)`,
  nullifiers by `(pool, nullifier)`; progress stored in `indexer_state`. A reorg
  just overwrites rows; each poll re-scans a small buffer behind the cursor.
- Backfill runs a bounded number of windows concurrently with 429 backoff; live
  mode then only scans the few new blocks per poll.
- A leaf-index gap check re-scans if a window was missed.

## HTTP API

- `GET /health`
- `GET /pools/:pool/utxos/range?start=<leaf>&end=<leaf>` — half-open `[start, end)`,
  ordered by leaf index, max span 10000. Fields: `index`, `commitment`,
  `encryptedOutput` (drop-in for the frontend's `fetchCommitments`).
- `GET /pools/:pool/utxos?fromIndex=<n>&limit=<n>` — limit-based incremental sync.
- `GET /pools/:pool/status` — `{ lastLeafIndex, commitmentCount, lastIndexedBlock, chainHead }`.
- `GET /pools/:pool/nullifiers?sinceBlock=<n>` — the spent set; client filters its
  decrypted notes locally instead of per-note `isSpent` RPC calls.

`:pool` is the lowercased pool contract address.

## Config (env)

| var | meaning | default |
|-----|---------|---------|
| `RPC_URL` | HyperEVM JSON-RPC | — |
| `DATABASE_URL` | Postgres | — |
| `POOLS` | JSON `[{address, deployBlock, label}]` | `[]` |
| `CONFIRMATIONS` | blocks behind head to index | 5 |
| `POLL_INTERVAL_MS` | poll cadence | 4000 |
| `LOG_CHUNK` | max getLogs span (≤1000) | 999 |
| `BACKFILL_CONCURRENCY` | concurrent backfill windows | 10 |
| `PORT` | HTTP port | 3000 |
| `CORS_ORIGIN` | allowed origin | `*` |

## Deploy (Railway)

Dockerfile + `railway.json` (healthcheck `/health`). Attach a Postgres plugin
(`DATABASE_URL` is injected); set `RPC_URL` and `POOLS`.

## Relayer (`/relay/*`) — v1, optional, same service

Gasless verify+submit relayer mounted on this service **only when
`RELAYER_PRIVATE_KEY` (+ `TRADER_ADDRESS`, `USDC_POOL_ADDRESS`,
`HYPE_POOL_ADDRESS`) are set**. Otherwise the indexer/API runs unchanged. The
frontend builds every proof; the relayer checks the tx pays it a fee
(≥ `MIN_FEE_*`), `callStatic`-simulates, then signs+submits (serialized nonce).

**v1 trade flow (no shielded settle):**
1. `POST /relay/trade` `{ proof, extData, params }` → TX1 `trade()`. The USDC fee
   is charged here and must cover the gas of **both** `trade()` and the later
   `deliver()` — size `MIN_FEE_USDC` accordingly. Returns `{ txHash, tradeId }`;
   the trade (account, assetCoreToken, size, recipient) is persisted.
2. **Delivery/cancel worker** polls every `RELAY_POLL_MS` (~8s): for each open
   trade it reads `trades(tradeId)` (status/account/assetCoreToken/size/deadline)
   and `core.spotBalance(account, assetCoreToken)` (`core = trader.core()`):
   - once `spotBalance >= size` → `callStatic` then **TX2 `deliver(tradeId)`**
   - else once `now > deadline` (still unfilled) → **`cancel(tradeId)`** (clean
     exit on non-fills; refunds per the contract)
   Gas paid by the relayer (covered by the upfront fee). Never delivers before
   the fill (async on HyperCore). Both are permissionless + idempotent (on-chain
   `status` + DB guard).

Other endpoints:
- `POST /relay/transact` `{ proof, extData, pool:'usdc'|'hype' }` → shielded
  deposit/withdraw (`pool.transact`), fee in-token → `{ txHash }`
- `GET /relay/info` → `{ relayer, trader, fees: { "<poolAddrLower>": "<feeBaseUnits>" } }`
- `GET /relay/health`

`recipient` + venue are frozen on-chain at `trade()` — the relayer can't
redirect; its only guard is `feeRecipient == relayer` + sufficient fee.

### Contract surface required (v1)

Built against a v1 HyperTrader that must expose (keep `src/relay/abis.ts` in sync):
- `trade(proof, extData, params)` (params incl. `deadline` uint64; 0 ⇒ now +
  defaultDeadlineSecs) `returns (uint256)` emitting
  `Traded(uint256 indexed tradeId, address account, uint64 assetCoreToken, uint64 size, address recipient, uint128 cloid)`
- `deliver(uint256 tradeId)` (permissionless; reverts if not filled / already done)
- `cancel(uint256 tradeId)` (permissionless; past deadline & unfilled) emitting
  `Cancelled(uint256 indexed tradeId, address recipient, uint256 usdcRefunded, uint256 assetRefunded)`
- `trades(uint256) view returns (account, recipient, assetCoreToken, size, venue, deadline, status)`
  — status enum: 0 None, 1 Open, 2 Delivered, 3 Cancelled
- `core() view returns (address)` → a gateway with `spotBalance(address, uint64) view returns (uint64)`
- the pools' `transact(proof, extData)`

The two-step shielded flow (initiate/settle/cancel/sell) is preserved on the
`v2` branch.
