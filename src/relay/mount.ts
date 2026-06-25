// v1 relayer, mounted on the backend's Hono app. Enabled only when
// RELAYER_PRIVATE_KEY (+ TRADER/USDC_POOL/HYPE_POOL addresses) are set.
//
// Flow (v1, no shielded settle):
//   /relay/trade  -> TX1 trade()  (charges the USDC fee upfront, opens a trade)
//   delivery worker polls the fill -> TX2 deliver(tradeId) once spotBalance >= size
//   /relay/transact -> pool.transact() (shielded deposit/withdraw, fee in-token)
//
// The relayer never builds a proof. It checks the fee pays it (sized to cover
// BOTH trade() and deliver() gas), callStatic-simulates, then signs+submits.
// recipient + venue are frozen on-chain at trade(): the relayer can't redirect.
import type { Hono } from 'hono'
import { ethers, BigNumber } from 'ethers'
import { TRADER_ABI, CORE_ABI, POOL_ABI, STATUS } from './abis'
import { checkFee } from './validate'
import { initRelayStore, recordTrade, openTradeIds, markDone } from './store'
import { isHumanOrder, buildTradeParams, randomCloid } from './order'

interface RelayConfig {
  privateKey: string
  rpcUrl: string
  chainId: number
  trader: string
  usdcPool: string
  hypePool: string
  coreGateway?: string
  minFeeUsdc: BigNumber
  minFeeHype: BigNumber
  gasTrade: number
  gasDeliver: number
  gasCancel: number
  pollMs: number
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : parseInt(v, 10)
}

function loadRelayConfig(): RelayConfig | null {
  const privateKey = process.env.RELAYER_PRIVATE_KEY
  const rpcUrl = process.env.RPC_URL
  if (!privateKey || !rpcUrl) return null
  const need = ['TRADER_ADDRESS', 'USDC_POOL_ADDRESS', 'HYPE_POOL_ADDRESS'] as const
  for (const n of need) {
    if (!process.env[n]) {
      console.warn(`[relay] ${n} not set — relayer disabled`)
      return null
    }
  }
  return {
    privateKey,
    rpcUrl,
    chainId: envInt('CHAIN_ID', 998),
    trader: process.env.TRADER_ADDRESS!.toLowerCase(),
    usdcPool: process.env.USDC_POOL_ADDRESS!.toLowerCase(),
    hypePool: process.env.HYPE_POOL_ADDRESS!.toLowerCase(),
    coreGateway: process.env.CORE_GATEWAY?.toLowerCase(),
    minFeeUsdc: BigNumber.from(process.env.MIN_FEE_USDC || '0'),
    minFeeHype: BigNumber.from(process.env.MIN_FEE_HYPE || '0'),
    gasTrade: envInt('GAS_TRADE', 2_500_000),
    gasDeliver: envInt('GAS_DELIVER', 2_000_000),
    gasCancel: envInt('GAS_CANCEL', 2_000_000),
    pollMs: envInt('RELAY_POLL_MS', 8000),
  }
}

function extractRevert(e: any): string {
  // include raw revert data (custom-error selector) when no message is present
  const data = e?.error?.data || e?.error?.error?.data || e?.data
  const base =
    e?.error?.error?.message || e?.error?.message || e?.reason || e?.body || e?.message || String(e)
  return String(data ? `${base} | data=${typeof data === 'string' ? data : JSON.stringify(data)}` : base).slice(0, 400)
}
const alreadyDone = (msg: string) => /not open|already|delivered|settled|cancel/i.test(msg)

export function mountRelay(app: Hono): boolean {
  const cfg = loadRelayConfig()
  if (!cfg) {
    console.log('Relayer disabled (set RELAYER_PRIVATE_KEY + TRADER/USDC_POOL/HYPE_POOL_ADDRESS to enable).')
    return false
  }

  const provider = new ethers.providers.JsonRpcProvider(cfg.rpcUrl, {
    chainId: cfg.chainId,
    name: `hyperevm-${cfg.chainId}`,
  })
  const wallet = new ethers.Wallet(cfg.privateKey, provider)
  const relayer = wallet.address.toLowerCase()
  const trader = new ethers.Contract(cfg.trader, TRADER_ABI, wallet)
  const pools: Record<string, ethers.Contract> = {
    usdc: new ethers.Contract(cfg.usdcPool, POOL_ABI, wallet),
    hype: new ethers.Contract(cfg.hypePool, POOL_ABI, wallet),
  }
  const minFeeFor = (pool: string) => (pool === 'hype' ? cfg.minFeeHype : cfg.minFeeUsdc)

  // serialized nonce management
  let lock: Promise<void> = Promise.resolve()
  let nextNonce: number | null = null
  async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = lock
    let release!: () => void
    lock = new Promise<void>((r) => (release = r))
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }
  async function send(c: ethers.Contract, method: string, args: any[], gasLimit?: number) {
    return withLock(async () => {
      if (nextNonce === null) nextNonce = await provider.getTransactionCount(relayer, 'pending')
      const overrides: ethers.Overrides = { nonce: nextNonce }
      if (gasLimit) overrides.gasLimit = gasLimit
      try {
        const tx = await c[method](...args, overrides)
        nextNonce = (nextNonce as number) + 1
        return tx
      } catch (e) {
        nextNonce = null
        throw e
      }
    })
  }
  const simulate = (c: ethers.Contract, method: string, args: any[]) =>
    c.callStatic[method](...args, { from: relayer })

  // ---------------------------------------------------------------- routes
  app.get('/relay/health', (c) => c.json({ ok: true, relayer, trader: cfg.trader }))

  app.get('/relay/info', (c) =>
    c.json({
      relayer,
      trader: cfg.trader,
      fees: { [cfg.usdcPool]: cfg.minFeeUsdc.toString(), [cfg.hypePool]: cfg.minFeeHype.toString() },
    }),
  )

  // TX1 — open a trade. Fee (USDC) is charged here and must cover trade()+deliver() gas.
  app.post('/relay/trade', async (c) => {
    try {
      const body = await c.req.json()
      const { proof, extData } = body
      let params = body.params ?? body.p ?? body.order
      if (!proof || !extData || !params) return c.json({ error: 'proof/extData/params required' }, 400)
      const fee = checkFee(extData, relayer, cfg.minFeeUsdc)
      if (!fee.ok) return c.json({ error: fee.error }, 400)
      // The front sends a human order { coin, size, limitPx, … }; map coin -> asset
      // + format sizes into the on-chain TradeParams tuple. (Already-formatted
      // tuples are passed through.)
      if (isHumanOrder(params)) {
        try {
          params = buildTradeParams(params, randomCloid())
        } catch (e) {
          return c.json({ error: 'bad_order', reason: extractRevert(e) }, 400)
        }
      }
      try {
        await simulate(trader, 'trade', [proof, extData, params])
      } catch (e) {
        const reason = extractRevert(e)
        console.error('[relay] /relay/trade sim revert:', reason, '| params:', JSON.stringify(params))
        return c.json({ error: 'simulation_reverted', reason }, 400)
      }
      const tx = await send(trader, 'trade', [proof, extData, params], cfg.gasTrade)
      const receipt = await tx.wait(1)
      let tradeId: string | undefined
      for (const log of receipt.logs ?? []) {
        try {
          const p = trader.interface.parseLog(log)
          if (p.name === 'Traded') tradeId = p.args.tradeId.toString()
        } catch {
          /* not ours */
        }
      }
      if (tradeId) await recordTrade(cfg.trader, tradeId, tx.hash)
      return c.json({ txHash: tx.hash, tradeId })
    } catch (e) {
      return c.json({ error: 'relay_failed', reason: extractRevert(e) }, 500)
    }
  })

  // Shielded deposit/withdraw — standard mixer transact, fee paid in-token.
  app.post('/relay/transact', async (c) => {
    try {
      const { proof, extData, pool } = await c.req.json()
      if (!proof || !extData || (pool !== 'usdc' && pool !== 'hype')) {
        return c.json({ error: "proof/extData required, pool must be 'usdc'|'hype'" }, 400)
      }
      const fee = checkFee(extData, relayer, minFeeFor(pool))
      if (!fee.ok) return c.json({ error: fee.error }, 400)
      const p = pools[pool]
      try {
        await simulate(p, 'transact', [proof, extData])
      } catch (e) {
        return c.json({ error: 'simulation_reverted', reason: extractRevert(e) }, 400)
      }
      const tx = await send(p, 'transact', [proof, extData])
      await tx.wait(1)
      return c.json({ txHash: tx.hash })
    } catch (e) {
      return c.json({ error: 'relay_failed', reason: extractRevert(e) }, 500)
    }
  })

  // ---------------------------------------------------------------- delivery worker
  let core: ethers.Contract | null = null
  const inFlight = new Set<string>()

  const resolveCore = async (): Promise<ethers.Contract> => {
    if (core) return core
    const addr = cfg.coreGateway ?? (await trader.core())
    core = new ethers.Contract(addr, CORE_ABI, provider)
    return core
  }

  // Finish a trade: deliver once filled, or cancel once past its deadline if not.
  const finish = async (id: string, now: number): Promise<void> => {
    if (inFlight.has(id)) return
    inFlight.add(id)
    try {
      const t = await trader.trades(BigNumber.from(id))
      if (Number(t.status) !== STATUS.Open) {
        await markDone(cfg.trader, id) // delivered or cancelled already
        return
      }
      const c = await resolveCore()
      const bal: BigNumber = await c.spotBalance(t.account, t.assetCoreToken)
      const filled = bal.gte(t.size)
      const action = filled ? 'deliver' : now > Number(t.deadline) ? 'cancel' : null
      if (!action) return // not filled and not past deadline → wait
      try {
        await simulate(trader, action, [BigNumber.from(id)])
      } catch (e) {
        if (alreadyDone(extractRevert(e))) await markDone(cfg.trader, id)
        return
      }
      const tx = await send(trader, action, [BigNumber.from(id)], action === 'deliver' ? cfg.gasDeliver : cfg.gasCancel)
      await tx.wait(1)
      await markDone(cfg.trader, id)
      console.log(`[relay] ${action} trade ${id} -> ${tx.hash}`)
    } catch (e) {
      console.error(`[relay] finish ${id} error:`, extractRevert(e))
    } finally {
      inFlight.delete(id)
    }
  }

  const workerTick = async (): Promise<void> => {
    try {
      const ids = await openTradeIds(cfg.trader)
      if (!ids.length) return
      const now = (await provider.getBlock('latest')).timestamp
      for (const id of ids) await finish(id, now)
    } catch (e) {
      console.error('[relay] worker tick error:', extractRevert(e))
    }
  }

  initRelayStore()
    .then(() => {
      setInterval(workerTick, cfg.pollMs)
      console.log(`Relayer enabled — signer ${relayer}, trader ${cfg.trader}, delivery worker every ${cfg.pollMs}ms`)
    })
    .catch((e) => console.error('[relay] store init failed:', extractRevert(e)))

  return true
}
