import { test, expect } from 'bun:test'
import { Hono } from 'hono'
import { mountRelay } from './mount'

const A = '0x000000000000000000000000000000000000aaaa'

test('relay stays disabled without RELAYER_PRIVATE_KEY', () => {
  delete process.env.RELAYER_PRIVATE_KEY
  const app = new Hono()
  expect(mountRelay(app)).toBe(false)
})

test('relay mounts and serves /relay/health when configured', async () => {
  process.env.RELAYER_PRIVATE_KEY =
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
  process.env.RPC_URL = process.env.RPC_URL || 'http://localhost:8545'
  process.env.CHAIN_ID = '998'
  process.env.TRADER_ADDRESS = A
  process.env.USDC_POOL_ADDRESS = A
  process.env.BTC_POOL_ADDRESS = A
  process.env.ADAPTER_ADDRESS = A
  const app = new Hono()
  expect(mountRelay(app)).toBe(true)
  const res = await app.request('/relay/health')
  expect(res.status).toBe(200)
  const body = (await res.json()) as any
  expect(body.ok).toBe(true)
  expect(body.relayer).toMatch(/^0x[0-9a-f]{40}$/)
})

test('relay/withdraw rejects a bad pool', async () => {
  const app = new Hono()
  mountRelay(app)
  const res = await app.request('/relay/withdraw', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proof: {}, extData: {}, pool: 'eth' }),
  })
  expect(res.status).toBe(400)
})
