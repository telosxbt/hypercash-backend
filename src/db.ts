// Postgres access + schema migration. Uses porsager/postgres (works under Bun).
import postgres from 'postgres'
import { config } from './config'

export const sql = postgres(config.databaseUrl, {
  max: 10,
  // Railway Postgres is plain TLS; allow it without a CA bundle.
  ssl: config.databaseUrl.includes('localhost') || config.databaseUrl.includes('127.0.0.1') ? false : 'prefer',
  onnotice: () => {},
})

const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS commitments (
  pool             TEXT   NOT NULL,
  leaf_index       BIGINT NOT NULL,
  commitment       TEXT   NOT NULL,
  encrypted_output TEXT   NOT NULL,
  block_number     BIGINT NOT NULL,
  tx_hash          TEXT   NOT NULL,
  log_index        INT    NOT NULL,
  PRIMARY KEY (pool, leaf_index)
);

CREATE TABLE IF NOT EXISTS nullifiers (
  pool         TEXT   NOT NULL,
  nullifier    TEXT   NOT NULL,
  block_number BIGINT NOT NULL,
  tx_hash      TEXT   NOT NULL,
  PRIMARY KEY (pool, nullifier)
);

CREATE TABLE IF NOT EXISTS indexer_state (
  pool       TEXT   PRIMARY KEY,
  last_block BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS commitments_pool_block ON commitments (pool, block_number);
CREATE INDEX IF NOT EXISTS nullifiers_pool_block ON nullifiers (pool, block_number);
`

export async function migrate(): Promise<void> {
  await sql.unsafe(SCHEMA)
}

// ---- queries used by the indexer -----------------------------------------

export async function getLastBlock(pool: string): Promise<number | null> {
  const rows = await sql<{ last_block: string }[]>`
    SELECT last_block FROM indexer_state WHERE pool = ${pool}`
  return rows.length ? Number(rows[0].last_block) : null
}

export async function setLastBlock(pool: string, block: number): Promise<void> {
  await sql`
    INSERT INTO indexer_state (pool, last_block) VALUES (${pool}, ${block})
    ON CONFLICT (pool) DO UPDATE SET last_block = EXCLUDED.last_block`
}

export interface CommitmentRow {
  pool: string
  leafIndex: number
  commitment: string
  encryptedOutput: string
  blockNumber: number
  txHash: string
  logIndex: number
}

export async function upsertCommitments(rows: CommitmentRow[]): Promise<void> {
  if (!rows.length) return
  const values = rows.map((r) => ({
    pool: r.pool,
    leaf_index: r.leafIndex,
    commitment: r.commitment,
    encrypted_output: r.encryptedOutput,
    block_number: r.blockNumber,
    tx_hash: r.txHash,
    log_index: r.logIndex,
  }))
  await sql`
    INSERT INTO commitments ${sql(
      values,
      'pool',
      'leaf_index',
      'commitment',
      'encrypted_output',
      'block_number',
      'tx_hash',
      'log_index',
    )}
    ON CONFLICT (pool, leaf_index) DO UPDATE SET
      commitment = EXCLUDED.commitment,
      encrypted_output = EXCLUDED.encrypted_output,
      block_number = EXCLUDED.block_number,
      tx_hash = EXCLUDED.tx_hash,
      log_index = EXCLUDED.log_index`
}

export async function insertNullifiers(
  rows: { pool: string; nullifier: string; blockNumber: number; txHash: string }[],
): Promise<void> {
  if (!rows.length) return
  const values = rows.map((r) => ({
    pool: r.pool,
    nullifier: r.nullifier,
    block_number: r.blockNumber,
    tx_hash: r.txHash,
  }))
  await sql`
    INSERT INTO nullifiers ${sql(values, 'pool', 'nullifier', 'block_number', 'tx_hash')}
    ON CONFLICT (pool, nullifier) DO NOTHING`
}

// ---- queries used by the API ----------------------------------------------

export async function getCommitmentsRange(pool: string, start: number, end: number) {
  return sql<{ index: string; commitment: string; encryptedOutput: string }[]>`
    SELECT leaf_index AS index, commitment, encrypted_output AS "encryptedOutput"
    FROM commitments
    WHERE pool = ${pool} AND leaf_index >= ${start} AND leaf_index < ${end}
    ORDER BY leaf_index ASC`
}

export async function getCommitmentsFrom(pool: string, fromIndex: number, limit: number) {
  return sql<{ index: string; commitment: string; encryptedOutput: string }[]>`
    SELECT leaf_index AS index, commitment, encrypted_output AS "encryptedOutput"
    FROM commitments
    WHERE pool = ${pool} AND leaf_index >= ${fromIndex}
    ORDER BY leaf_index ASC
    LIMIT ${limit}`
}

export async function getStatus(pool: string) {
  const rows = await sql<{ max_index: string | null; cnt: string }[]>`
    SELECT MAX(leaf_index) AS max_index, COUNT(*) AS cnt FROM commitments WHERE pool = ${pool}`
  const state = await sql<{ last_block: string }[]>`
    SELECT last_block FROM indexer_state WHERE pool = ${pool}`
  return {
    lastLeafIndex: rows[0].max_index === null ? -1 : Number(rows[0].max_index),
    commitmentCount: Number(rows[0].cnt),
    lastIndexedBlock: state.length ? Number(state[0].last_block) : 0,
  }
}

export async function getNullifiers(pool: string, sinceBlock: number) {
  const rows = await sql<{ nullifier: string }[]>`
    SELECT nullifier FROM nullifiers
    WHERE pool = ${pool} AND block_number >= ${sinceBlock}
    ORDER BY block_number ASC`
  return rows.map((r) => r.nullifier)
}

/** Smallest leaf_index missing from 0..max (a gap = a missed window). null if contiguous. */
export async function firstGap(pool: string): Promise<number | null> {
  const rows = await sql<{ gap: string | null }[]>`
    SELECT MIN(leaf_index + 1) AS gap
    FROM commitments c
    WHERE pool = ${pool}
      AND NOT EXISTS (
        SELECT 1 FROM commitments n
        WHERE n.pool = c.pool AND n.leaf_index = c.leaf_index + 1
      )
      AND leaf_index + 1 <= (SELECT MAX(leaf_index) FROM commitments WHERE pool = ${pool})`
  return rows[0].gap === null ? null : Number(rows[0].gap)
}
