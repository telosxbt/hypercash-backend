// Optional relayer, mounted onto the backend's Hono app. Enabled only when
// RELAYER_PRIVATE_KEY (+ contract addresses) are set, so the indexer/API runs
// fine without it. The relayer NEVER builds a proof — the frontend sends
// pre-built {proof, extData, params}; the relayer checks the fee pays it,
// callStatic-simulates to reject reverts without burning gas, then signs+submits
// (paying the gas) with serialized nonce management.
import type { Hono } from 'hono'
import { ethers, BigNumber } from 'ethers'
import { TRADER_ABI, ADAPTER_ABI, POOL_ABI, STATUS } from './abis'
import { checkFee } from './validate'

interface RelayConfig {
  privateKey: string
  rpcUrl: string
  chainId: number
  trader: string
  usdcPool: string
  btcPool: string
  adapter: string
  minFeeUsdc: BigNumber
  minFeeBtc: BigNumber
  gasInitiate: number
  gasSettle: number
  gasCancel: number
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name]
  return v === undefined || v === '' ? fallback : parseInt(v, 10)
}

function loadRelayConfig(): RelayConfig | null {
  const privateKey = process.env.RELAYER_PRIVATE_KEY
  if (!privateKey) return null
  const rpcUrl = process.env.RPC_URL
  if (!rpcUrl) return null
  const need = ['TRADER_ADDRESS', 'USDC_POOL_ADDRESS', 'BTC_POOL_ADDRESS', 'ADAPTER_ADDRESS'] as const
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
    btcPool: process.env.BTC_POOL_ADDRESS!.toLowerCase(),
    adapter: process.env.ADAPTER_ADDRESS!.toLowerCase(),
    minFeeUsdc: BigNumber.from(process.env.MIN_FEE_USDC || '0'),
    minFeeBtc: BigNumber.from(process.env.MIN_FEE_BTC || '0'),
    gasInitiate: envInt('GAS_INITIATE', 2_500_000),
    gasSettle: envInt('GAS_SETTLE', 2_500_000),
    gasCancel: envInt('GAS_CANCEL', 1_500_000),
  }
}

function extractRevert(e: any): string {
  return String(
    e?.error?.error?.message || e?.error?.message || e?.reason || e?.body || e?.message || e,
  ).slice(0, 300)
}

/** Mount /relay/* on the given app. Returns true if the relayer is enabled. */
export function mountRelay(app: Hono): boolean {
  const cfg = loadRelayConfig()
  if (!cfg) {
    console.log('Relayer disabled (set RELAYER_PRIVATE_KEY + TRADER/USDC_POOL/BTC_POOL/ADAPTER_ADDRESS to enable).')
    return false
  }

  const provider = new ethers.providers.JsonRpcProvider(cfg.rpcUrl, {
    chainId: cfg.chainId,
    name: `hyperevm-${cfg.chainId}`,
  })
  const wallet = new ethers.Wallet(cfg.privateKey, provider)
  const relayer = wallet.address.toLowerCase()
  const trader = new ethers.Contract(cfg.trader, TRADER_ABI, wallet)
  const adapter = new ethers.Contract(cfg.adapter, ADAPTER_ABI, provider)
  const pools = {
    usdc: new ethers.Contract(cfg.usdcPool, POOL_ABI, wallet),
    btc: new ethers.Contract(cfg.btcPool, POOL_ABI, wallet),
  }

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
  const isSell = (s: unknown) => s === 'sell'
  function parseInitEvent(receipt: any, name: string) {
    for (const log of receipt.logs ?? []) {
      try {
        const p = trader.interface.parseLog(log)
        if (p.name === name) return { tradeId: p.args.tradeId.toString(), cloid: p.args.cloid.toString() }
      } catch {
        /* skip */
      }
    }
    return { tradeId: undefined, cloid: undefined }
  }

  app.get('/relay/health', (c) => c.json({ ok: true, relayer, trader: cfg.trader }))

  // Frontend-facing info: relayer address + min fee per pool (base units, keyed
  // by lowercased pool address) so the UI can build a fee the relayer accepts.
  app.get('/relay/info', (c) =>
    c.json({
      relayer,
      fees: {
        [cfg.usdcPool]: cfg.minFeeUsdc.toString(),
        [cfg.btcPool]: cfg.minFeeBtc.toString(),
      },
    }),
  )

  app.post('/relay/initiate', async (c) => {
    try {
      const body = await c.req.json()
      const { proof, extData, side } = body
      const params = body.params ?? body.p // frontend sends `p`
      if (!proof || !extData || !params) return c.json({ error: 'proof/extData/p required' }, 400)
      const fee = checkFee(extData, relayer, isSell(side) ? cfg.minFeeBtc : cfg.minFeeUsdc)
      if (!fee.ok) return c.json({ error: fee.error }, 400)
      const method = isSell(side) ? 'initiateSell' : 'initiateTrade'
      try {
        await simulate(trader, method, [proof, extData, params])
      } catch (e) {
        return c.json({ error: 'simulation_reverted', reason: extractRevert(e) }, 400)
      }
      const tx = await send(trader, method, [proof, extData, params], cfg.gasInitiate)
      const receipt = await tx.wait(1)
      const { tradeId, cloid } = parseInitEvent(receipt, isSell(side) ? 'SellInitiated' : 'TradeInitiated')
      return c.json({ tradeId, cloid, txHash: tx.hash })
    } catch (e) {
      return c.json({ error: 'relay_failed', reason: extractRevert(e) }, 500)
    }
  })

  app.post('/relay/settle', async (c) => {
    try {
      const { tradeId, proof, ext, side } = await c.req.json()
      if (tradeId === undefined || !proof || !ext) return c.json({ error: 'tradeId/proof/ext required' }, 400)
      const t = await trader[isSell(side) ? 'sells' : 'trades'](BigNumber.from(tradeId))
      if (Number(t.status) !== STATUS.Open) return c.json({ error: 'trade_not_open', status: Number(t.status) }, 409)
      const [filledSize] = await adapter.orderStatus(t.cloid)
      if (BigNumber.from(filledSize).lt(t.size))
        return c.json({ error: 'not_filled_yet', filledSize: filledSize.toString(), size: t.size.toString() }, 409)
      const fee = checkFee(ext, relayer, cfg.minFeeBtc)
      if (!fee.ok) return c.json({ error: fee.error }, 400)
      const method = isSell(side) ? 'settleSell' : 'settleTrade'
      try {
        await simulate(trader, method, [BigNumber.from(tradeId), proof, ext])
      } catch (e) {
        return c.json({ error: 'simulation_reverted', reason: extractRevert(e) }, 400)
      }
      const tx = await send(trader, method, [BigNumber.from(tradeId), proof, ext], cfg.gasSettle)
      await tx.wait(1)
      return c.json({ txHash: tx.hash })
    } catch (e) {
      return c.json({ error: 'relay_failed', reason: extractRevert(e) }, 500)
    }
  })

  app.post('/relay/cancel', async (c) => {
    try {
      const { tradeId, proof, ext, side } = await c.req.json()
      if (tradeId === undefined || !proof || !ext) return c.json({ error: 'tradeId/proof/ext required' }, 400)
      const t = await trader[isSell(side) ? 'sells' : 'trades'](BigNumber.from(tradeId))
      if (Number(t.status) !== STATUS.Open) return c.json({ error: 'trade_not_open', status: Number(t.status) }, 409)
      const now = (await provider.getBlock('latest')).timestamp
      if (now <= Number(t.deadline)) return c.json({ error: 'before_deadline', deadline: Number(t.deadline) }, 409)
      const [filledSize] = await adapter.orderStatus(t.cloid)
      if (BigNumber.from(filledSize).gte(t.size)) return c.json({ error: 'already_filled' }, 409)
      const fee = checkFee(ext, relayer, isSell(side) ? cfg.minFeeBtc : cfg.minFeeUsdc)
      if (!fee.ok) return c.json({ error: fee.error }, 400)
      const method = isSell(side) ? 'cancelSell' : 'cancelTrade'
      try {
        await simulate(trader, method, [BigNumber.from(tradeId), proof, ext])
      } catch (e) {
        return c.json({ error: 'simulation_reverted', reason: extractRevert(e) }, 400)
      }
      const tx = await send(trader, method, [BigNumber.from(tradeId), proof, ext], cfg.gasCancel)
      await tx.wait(1)
      return c.json({ txHash: tx.hash })
    } catch (e) {
      return c.json({ error: 'relay_failed', reason: extractRevert(e) }, 500)
    }
  })

  app.post('/relay/withdraw', async (c) => {
    try {
      const { proof, extData, pool } = await c.req.json()
      if (!proof || !extData || (pool !== 'usdc' && pool !== 'btc'))
        return c.json({ error: "proof/extData required, pool must be 'usdc'|'btc'" }, 400)
      const fee = checkFee(extData, relayer, pool === 'btc' ? cfg.minFeeBtc : cfg.minFeeUsdc)
      if (!fee.ok) return c.json({ error: fee.error }, 400)
      const p = pools[pool as 'usdc' | 'btc']
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

  console.log(`Relayer enabled — signer ${relayer}, trader ${cfg.trader}`)
  return true
}
