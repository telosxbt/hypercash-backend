// Configuration, all env-driven (see .env.example). Pools are a configurable
// list so new ones can be added without code changes — the same source of truth
// as the frontend's deployment.json.

export interface PoolConfig {
  /** lowercased contract address */
  address: string
  /** block the pool was deployed at — start indexing here */
  deployBlock: number
  /** human label (usdc, weth, …) — optional, for logs */
  label?: string
}

export interface Config {
  rpcUrl: string
  databaseUrl: string
  pools: PoolConfig[]
  confirmations: number
  pollIntervalMs: number
  /** max getLogs block span; public HyperEVM RPC caps at 1000 */
  chunk: number
  /** how many backfill windows to run concurrently */
  backfillConcurrency: number
  port: number
  corsOrigin: string
}

function env(name: string, fallback?: string): string {
  const v = process.env[name]
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback
    throw new Error(`Missing required env var ${name}`)
  }
  return v
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : parseInt(v, 10)
}

// POOLS is a JSON array: [{"address":"0x..","deployBlock":123,"label":"usdc"}]
function parsePools(): PoolConfig[] {
  const raw = process.env.POOLS
  if (!raw) return []
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(`POOLS is not valid JSON: ${(e as Error).message}`)
  }
  if (!Array.isArray(parsed)) throw new Error('POOLS must be a JSON array')
  return parsed.map((p: any, i: number) => {
    if (!p.address || typeof p.address !== 'string') throw new Error(`POOLS[${i}].address missing`)
    if (p.deployBlock === undefined) throw new Error(`POOLS[${i}].deployBlock missing`)
    return {
      address: p.address.toLowerCase(),
      deployBlock: Number(p.deployBlock),
      label: p.label,
    }
  })
}

export function loadConfig(): Config {
  return {
    rpcUrl: env('RPC_URL'),
    databaseUrl: env('DATABASE_URL'),
    pools: parsePools(),
    confirmations: envInt('CONFIRMATIONS', 5),
    pollIntervalMs: envInt('POLL_INTERVAL_MS', 4000),
    chunk: Math.min(envInt('LOG_CHUNK', 999), 1000),
    backfillConcurrency: envInt('BACKFILL_CONCURRENCY', 10),
    port: envInt('PORT', 3000),
    corsOrigin: env('CORS_ORIGIN', '*'),
  }
}

export const config = loadConfig()
