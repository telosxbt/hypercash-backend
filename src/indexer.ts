// Continuous, reorg-safe, multi-pool event indexer.
import { ethers } from 'ethers'
import { config, type PoolConfig } from './config'
import { NEW_COMMITMENT_TOPIC, NEW_NULLIFIER_TOPIC, decodeLog, type RawLog } from './abi'
import {
  getLastBlock,
  setLastBlock,
  upsertCommitments,
  insertNullifiers,
  firstGap,
  type CommitmentRow,
} from './db'

export const provider = new ethers.providers.JsonRpcProvider(config.rpcUrl)

// Re-scan this many blocks behind the cursor each poll so reorged-out logs get
// corrected by the idempotent upserts.
const REORG_BUFFER = 2

let latestChainHead = 0
export function getChainHead(): number {
  return latestChainHead
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Only TRUE size-cap errors should trigger a window split. The generic
// "invalid block range" some nodes return under load is NOT a size problem —
// splitting a sub-cap window just multiplies failing calls. Treat it as transient.
const isRangeError = (msg: string) =>
  /exceeds max block range|up to a \d+ block range|limited to a [\d,]+ range|query returned more than|response size|max is \d+ blocks/i.test(
    msg,
  )
const isTransient = (msg: string) =>
  /rate limit|429|too many|timeout|ETIMEDOUT|ECONN|invalid block range|bad response|noNetwork|could not detect network|503|502|temporarily/i.test(
    msg,
  )

// Below this span we stop splitting and just retry — QuikNode's HyperEVM testnet
// load-balances across nodes with inconsistent archive depth, so deep ranges
// fail erratically by node, not cleanly by size.
const MIN_SPLIT_SPAN = 50
const isSplittable = (msg: string) => isRangeError(msg) || /invalid block range/i.test(msg)

// Scan one window. Strategy: a too-large / flaky-large range is halved (handles
// both true size caps — 1000 QuikNode, 10 Alchemy — and big deep ranges that a
// node rejects); once small, we retry with jittered backoff until a node that
// actually has the data answers.
async function scanWindow(pool: PoolConfig, fromBlock: number, toBlock: number, attempt = 0): Promise<void> {
  let logs: ethers.providers.Log[]
  try {
    logs = await provider.getLogs({
      address: pool.address,
      fromBlock,
      toBlock,
      topics: [[NEW_COMMITMENT_TOPIC, NEW_NULLIFIER_TOPIC]],
    })
  } catch (e: any) {
    const msg = String(e?.error?.message || e?.body || e?.message || e)
    const span = toBlock - fromBlock + 1
    if (isSplittable(msg) && span > MIN_SPLIT_SPAN && toBlock > fromBlock) {
      const mid = Math.floor((fromBlock + toBlock) / 2)
      await scanWindow(pool, fromBlock, mid)
      await scanWindow(pool, mid + 1, toBlock)
      return
    }
    if ((isSplittable(msg) || isTransient(msg)) && attempt < 20) {
      await sleep(Math.min(300 * 2 ** Math.min(attempt, 4), 4000) + Math.floor(Math.random() * 500))
      return scanWindow(pool, fromBlock, toBlock, attempt + 1)
    }
    throw e
  }

  const commitments: CommitmentRow[] = []
  const nullifiers: { pool: string; nullifier: string; blockNumber: number; txHash: string }[] = []

  for (const log of logs) {
    const dec = decodeLog(log as unknown as RawLog)
    if (!dec) continue
    if (dec.kind === 'commitment') {
      commitments.push({
        pool: pool.address,
        leafIndex: dec.leafIndex,
        commitment: dec.commitment,
        encryptedOutput: dec.encryptedOutput,
        blockNumber: dec.blockNumber,
        txHash: dec.txHash,
        logIndex: dec.logIndex,
      })
    } else {
      nullifiers.push({
        pool: pool.address,
        nullifier: dec.nullifier,
        blockNumber: dec.blockNumber,
        txHash: dec.txHash,
      })
    }
  }

  await upsertCommitments(commitments)
  await insertNullifiers(nullifiers)
}

// Scan [from, to] in <=chunk windows, a bounded number concurrently. Advances
// the persisted cursor only after a whole concurrent batch has succeeded.
async function scanRange(pool: PoolConfig, from: number, to: number): Promise<void> {
  const windows: [number, number][] = []
  for (let s = from; s <= to; s += config.chunk) {
    windows.push([s, Math.min(s + config.chunk - 1, to)])
  }
  for (let i = 0; i < windows.length; i += config.backfillConcurrency) {
    const batch = windows.slice(i, i + config.backfillConcurrency)
    const results = await Promise.allSettled(batch.map(([a, b]) => scanWindow(pool, a, b)))
    const firstFail = results.findIndex((r) => r.status === 'rejected')
    if (firstFail === -1) {
      await setLastBlock(pool.address, batch[batch.length - 1][1])
      continue
    }
    // Advance only through the contiguous success prefix, then stop so the next
    // poll resumes at the failed window (bounded re-scan, never an infinite loop).
    if (firstFail > 0) await setLastBlock(pool.address, batch[firstFail - 1][1])
    const reason = (results[firstFail] as PromiseRejectedResult).reason
    throw new Error(`window ${batch[firstFail][0]}-${batch[firstFail][1]} failed: ${String(reason).slice(0, 120)}`)
  }
}

export async function indexPoolOnce(pool: PoolConfig): Promise<void> {
  const head = await provider.getBlockNumber()
  latestChainHead = head
  const safeHead = head - config.confirmations
  if (safeHead < pool.deployBlock) return

  const last = await getLastBlock(pool.address)
  const cursor = last ?? pool.deployBlock - 1
  // Rewind a touch for reorg safety; never before deployBlock.
  const from = Math.max(pool.deployBlock, cursor - REORG_BUFFER + 1)
  if (from > safeHead) return

  await scanRange(pool, from, safeHead)

  // Gap check: contiguous leaf indices from 0. A gap means a missed window.
  const gap = await firstGap(pool.address)
  if (gap !== null) {
    console.warn(`[${pool.label ?? pool.address}] leaf gap at ${gap} — re-scanning from deployBlock`)
    await scanRange(pool, pool.deployBlock, safeHead)
  }
}

async function poolLoop(pool: PoolConfig): Promise<void> {
  const tag = pool.label ?? pool.address
  for (;;) {
    try {
      await indexPoolOnce(pool)
      console.log(`[${tag}] indexed up to ${await getLastBlock(pool.address)} (head ${latestChainHead})`)
    } catch (e) {
      console.error(`[${tag}] index error:`, (e as Error).message)
    }
    await sleep(config.pollIntervalMs)
  }
}

// Launch one independent loop per pool — a slow pool never blocks the others.
export function startIndexer(): void {
  if (!config.pools.length) {
    console.warn('No pools configured (POOLS env empty) — indexer idle.')
    return
  }
  for (const pool of config.pools) {
    console.log(`Indexing pool ${pool.label ?? ''} ${pool.address} from block ${pool.deployBlock}`)
    poolLoop(pool)
  }
}
