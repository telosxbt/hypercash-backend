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

## Relayer (`/relay/*`) — optional, same service

A gasless verify+submit relayer is mounted on this service **only when
`RELAYER_PRIVATE_KEY` (+ `TRADER_ADDRESS`, `USDC_POOL_ADDRESS`,
`BTC_POOL_ADDRESS`, `ADAPTER_ADDRESS`) are set**. Otherwise the indexer/API runs
unchanged. The frontend builds every proof; the relayer only checks the tx pays
it a fee (≥ `MIN_FEE_USDC`/`MIN_FEE_BTC`), `callStatic`-simulates to reject
reverts without burning gas, then signs+submits (serialized nonce, fixed gas for
CoreWriter txs).

- `GET /relay/info` → `{ relayer, fees: { "<poolAddrLower>": "<feeBaseUnits>" } }`
- `POST /relay/initiate` `{ proof, extData, p, side?:'buy'|'sell' }` → `{ tradeId, cloid, txHash }` (also accepts `params` for `p`)
- `POST /relay/settle` `{ tradeId, proof, ext, side }` → `{ txHash }` (needs `orderStatus.filledSize >= size`, else `409`)
- `POST /relay/cancel` `{ tradeId, proof, ext, side }` → `{ txHash }` (needs `now > deadline` & not filled)
- `POST /relay/withdraw` `{ proof, extData, pool:'usdc'|'btc' }` → `{ txHash }`
- `GET /relay/health`

**Contract deltas (built to spec; current `feat/hypertrade` is behind):** sell
side (`initiateSell`/`settleSell`/`cancelSell`/`sells`/`SellInitiated`) doesn't
exist yet; `settle/cancel` currently take only `tradeId` (spec passes
`(tradeId, proof, ext)` + BTC fee); `adapter.orderStatus` is a stub `(0,0)`.
Buy + withdraw map to the current contract. Keep `src/relay/abis.ts` in sync with
the deployed contract.
