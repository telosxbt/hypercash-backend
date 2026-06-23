// DB + range tests. Gated on TEST_DATABASE_URL (a throwaway Postgres). Skipped
// when absent so `bun test` works without a database.
import { test, expect, beforeAll, afterAll } from 'bun:test'

const TEST_DB = process.env.TEST_DATABASE_URL
const run = TEST_DB ? test : test.skip

// config.ts requires these at import time; set them before importing db.
process.env.DATABASE_URL = TEST_DB ?? 'postgres://localhost/none'
process.env.RPC_URL = process.env.RPC_URL ?? 'http://localhost:8545'
process.env.POOLS = process.env.POOLS ?? '[]'

const POOL = '0xpooltest0000000000000000000000000000beef'

let db: typeof import('./db')

beforeAll(async () => {
  if (!TEST_DB) return
  db = await import('./db')
  await db.migrate()
  await db.sql`DELETE FROM commitments WHERE pool = ${POOL}`
  await db.sql`DELETE FROM nullifiers WHERE pool = ${POOL}`
  await db.sql`DELETE FROM indexer_state WHERE pool = ${POOL}`
})

afterAll(async () => {
  if (db?.sql) await db.sql.end({ timeout: 5 })
})

run('range query is ordered and half-open [start, end)', async () => {
  const rows = [0, 1, 2, 3, 4].map((i) => ({
    pool: POOL,
    leafIndex: i,
    commitment: '0x' + String(i).padStart(64, '0'),
    encryptedOutput: '0x0' + i,
    blockNumber: 100 + i,
    txHash: '0x' + 'a'.repeat(64),
    logIndex: 0,
  }))
  await db.upsertCommitments(rows)

  const out = await db.getCommitmentsRange(POOL, 1, 4)
  expect(out.map((r) => Number(r.index))).toEqual([1, 2, 3]) // 4 excluded
})

run('upserts are idempotent (re-index does not duplicate)', async () => {
  const row = [
    {
      pool: POOL,
      leafIndex: 0,
      commitment: '0x' + '0'.repeat(64),
      encryptedOutput: '0xbeef',
      blockNumber: 100,
      txHash: '0x' + 'a'.repeat(64),
      logIndex: 0,
    },
  ]
  await db.upsertCommitments(row)
  await db.upsertCommitments(row) // re-run
  const s = await db.getStatus(POOL)
  expect(s.commitmentCount).toBe(5) // still the 5 from the previous test
  expect(s.lastLeafIndex).toBe(4)
})

run('nullifiers insert + sinceBlock filter', async () => {
  await db.insertNullifiers([
    { pool: POOL, nullifier: '0x' + '1'.repeat(64), blockNumber: 10, txHash: '0x' + 'b'.repeat(64) },
    { pool: POOL, nullifier: '0x' + '2'.repeat(64), blockNumber: 20, txHash: '0x' + 'b'.repeat(64) },
  ])
  await db.insertNullifiers([
    { pool: POOL, nullifier: '0x' + '1'.repeat(64), blockNumber: 10, txHash: '0x' + 'b'.repeat(64) }, // dup
  ])
  const all = await db.getNullifiers(POOL, 0)
  expect(all.length).toBe(2) // dup ignored
  const since15 = await db.getNullifiers(POOL, 15)
  expect(since15).toEqual(['0x' + '2'.repeat(64)])
})

run('firstGap detects a missing leaf', async () => {
  await db.sql`DELETE FROM commitments WHERE pool = ${POOL}`
  await db.upsertCommitments(
    [0, 1, 3].map((i) => ({
      pool: POOL,
      leafIndex: i,
      commitment: '0x' + String(i).padStart(64, '0'),
      encryptedOutput: '0x0' + i,
      blockNumber: 100 + i,
      txHash: '0x' + 'a'.repeat(64),
      logIndex: 0,
    })),
  )
  const gap = await db.firstGap(POOL)
  expect(gap).toBe(2)
})
