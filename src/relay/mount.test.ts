import { test, expect, beforeAll } from 'bun:test'
import { Hono } from 'hono'

// config.ts (via store -> db) needs these at import time. Set before importing mount.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/none'
process.env.RPC_URL = process.env.RPC_URL || 'http://localhost:8545'
process.env.POOLS = process.env.POOLS || '[]'

const USDC = '0x0000000000000000000000000000000000005dc0'
const HYPE = '0x000000000000000000000000000000000000ace0'
const TRADER = '0x000000000000000000000000000000000000aaaa'

let mountRelay: (app: Hono) => boolean

beforeAll(async () => {
  ;({ mountRelay } = await import('./mount'))
})

function enable() {
  process.env.RELAYER_PRIVATE_KEY =
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
  process.env.CHAIN_ID = '998'
  process.env.TRADER_ADDRESS = TRADER
  process.env.USDC_POOL_ADDRESS = USDC
  process.env.HYPE_POOL_ADDRESS = HYPE
  process.env.MIN_FEE_USDC = '1000'
  process.env.MIN_FEE_HYPE = '7'
}

test('disabled without RELAYER_PRIVATE_KEY', () => {
  delete process.env.RELAYER_PRIVATE_KEY
  expect(mountRelay(new Hono())).toBe(false)
})

test('disabled when a pool address is missing', () => {
  enable()
  delete process.env.HYPE_POOL_ADDRESS
  expect(mountRelay(new Hono())).toBe(false)
  process.env.HYPE_POOL_ADDRESS = HYPE
})

test('enabled → /relay/health + /relay/info (per-pool fees)', async () => {
  enable()
  const app = new Hono()
  expect(mountRelay(app)).toBe(true)
  const health = (await (await app.request('/relay/health')).json()) as any
  expect(health.ok).toBe(true)
  expect(health.relayer).toMatch(/^0x[0-9a-f]{40}$/)
  const info = (await (await app.request('/relay/info')).json()) as any
  expect(info.fees[USDC]).toBe('1000')
  expect(info.fees[HYPE]).toBe('7')
})

test('/relay/trade validates payload', async () => {
  enable()
  const app = new Hono()
  mountRelay(app)
  const res = await app.request('/relay/trade', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  expect(res.status).toBe(400)
  expect(((await res.json()) as any).error).toContain('required')
})

test('/relay/trade rejects wrong feeRecipient', async () => {
  enable()
  const app = new Hono()
  mountRelay(app)
  const res = await app.request('/relay/trade', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proof: {},
      extData: { feeRecipient: '0xdead000000000000000000000000000000000000', fee: '99999' },
      params: {},
    }),
  })
  expect(res.status).toBe(400)
  expect(((await res.json()) as any).error).toContain('feeRecipient')
})

test('/relay/transact rejects a bad pool', async () => {
  enable()
  const app = new Hono()
  mountRelay(app)
  const res = await app.request('/relay/transact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proof: {}, extData: {}, pool: 'btc' }),
  })
  expect(res.status).toBe(400)
})
