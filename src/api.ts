// Read-only HTTP API (Hono). Mirrors Privacy Cash: paginate commitments by leaf
// index so the frontend pulls everything in a few calls regardless of chain age.
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { config } from './config'
import { getChainHead, provider } from './indexer'
import {
  getCommitmentsRange,
  getCommitmentsFrom,
  getStatus,
  getNullifiers,
} from './db'

const MAX_SPAN = 10000

export const app = new Hono()

app.use('*', cors({ origin: config.corsOrigin, allowMethods: ['GET', 'OPTIONS'] }))

app.get('/health', (c) => c.json({ ok: true, pools: config.pools.map((p) => p.address) }))

function poolParam(c: any): string {
  return String(c.req.param('pool')).toLowerCase()
}

// Short cache — data is append-only.
app.use('/pools/*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'public, max-age=3')
})

// §5.1 commitments by leaf-index range (primary)
app.get('/pools/:pool/utxos/range', async (c) => {
  const pool = poolParam(c)
  const start = parseInt(c.req.query('start') ?? '0', 10)
  const end = parseInt(c.req.query('end') ?? '0', 10)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return c.json({ error: 'invalid start/end' }, 400)
  }
  if (end - start > MAX_SPAN) {
    return c.json({ error: `range too large, max span ${MAX_SPAN}` }, 400)
  }
  const rows = await getCommitmentsRange(pool, start, end)
  return c.json({
    pool,
    start,
    end,
    utxos: rows.map((r) => ({
      index: Number(r.index),
      commitment: r.commitment,
      encryptedOutput: r.encryptedOutput,
    })),
  })
})

// §5.4 (optional) limit-based incremental sync
app.get('/pools/:pool/utxos', async (c) => {
  const pool = poolParam(c)
  const fromIndex = parseInt(c.req.query('fromIndex') ?? '0', 10)
  const limit = Math.min(parseInt(c.req.query('limit') ?? '1000', 10), MAX_SPAN)
  if (!Number.isFinite(fromIndex) || fromIndex < 0) return c.json({ error: 'invalid fromIndex' }, 400)
  const rows = await getCommitmentsFrom(pool, fromIndex, limit)
  return c.json({
    pool,
    fromIndex,
    limit,
    utxos: rows.map((r) => ({
      index: Number(r.index),
      commitment: r.commitment,
      encryptedOutput: r.encryptedOutput,
    })),
  })
})

// §5.2 sync status / head
app.get('/pools/:pool/status', async (c) => {
  const pool = poolParam(c)
  const s = await getStatus(pool)
  let chainHead = getChainHead()
  if (!chainHead) {
    try {
      chainHead = await provider.getBlockNumber()
    } catch {
      /* leave 0 */
    }
  }
  return c.json({ pool, ...s, chainHead })
})

// §5.3 nullifiers (spent set)
app.get('/pools/:pool/nullifiers', async (c) => {
  const pool = poolParam(c)
  const sinceBlock = parseInt(c.req.query('sinceBlock') ?? '0', 10)
  const nullifiers = await getNullifiers(pool, Number.isFinite(sinceBlock) ? sinceBlock : 0)
  return c.json({ pool, nullifiers })
})
