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

// getLogs with backoff on transient errors. Range-too-large errors are rethrown
// so the caller can split the window.
async function fetchLogs(filter: ethers.providers.Filter, tries = 8): Promise<ethers.providers.Log[]> {
  for (let i = 0; ; i++) {
    try {
      return await provider.getLogs(filter)
    } catch (e: any) {
      const msg = String(e?.error?.message || e?.body || e?.message || e)
      if (isRangeError(msg)) throw e // caller will split
      if (i >= tries - 1 || (!isTransient(msg) && i >= 2)) throw e
      await sleep(Math.min(400 * 2 ** i, 8000))
    }
  }
}

// Scan one window; if the provider rejects the block range (caps vary: 1000 on
// QuikNode, as little as 10 on Alchemy free tier), recursively halve it so the
// indexer is correct regardless of the RPC's limit.
async function scanWindow(pool: PoolConfig, fromBlock: number, toBlock: number): Promise<void> {
  let logs: ethers.providers.Log[]
  try {
    logs = await fetchLogs({
      address: pool.address,
      fromBlock,
      toBlock,
      topics: [[NEW_COMMITMENT_TOPIC, NEW_NULLIFIER_TOPIC]],
    })
  } catch (e: any) {
    const msg = String(e?.error?.message || e?.body || e?.message || e)
    if (isRangeError(msg) && toBlock > fromBlock) {
      const mid = Math.floor((fromBlock + toBlock) / 2)
      await scanWindow(pool, fromBlock, mid)
      await scanWindow(pool, mid + 1, toBlock)
      return
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
    await Promise.all(batch.map(([a, b]) => scanWindow(pool, a, b)))
    await setLastBlock(pool.address, batch[batch.length - 1][1])
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
