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
import { TRADER_ABI, CORE_ABI, POOL_ABI, ERC20_PERMIT_ABI, STATUS } from './abis'
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
  minFeeDeposit: BigNumber
  bridgeFee: BigNumber
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
    // Deposit fee defaults to 0 (gasless onboarding) so a first-time depositor
    // isn't blocked by the trade fee; raise MIN_FEE_DEPOSIT to recover gas.
    minFeeDeposit: BigNumber.from(process.env.MIN_FEE_DEPOSIT || '0'),
    // Flat fee (in the withdrawn token's units) the relayer keeps on
    // /relay/withdrawToCore to cover the permit + 2 transferFrom gas. The bridged
    // amount sent to HyperCore is value - bridgeFee. Defaults to 0.
    bridgeFee: BigNumber.from(process.env.BRIDGE_FEE || '0'),
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

// HyperCore spot bridge: sending a linked ERC20 to this per-token system address
// credits the owner's HyperCore spot balance. The address is the fixed base
// 0x2000…0000 plus the token's core index. (Same scheme HyperCore uses for
// EVM->Core token transfers.)
const CORE_SYSTEM_BASE = BigNumber.from('0x2000000000000000000000000000000000000000')
function systemAddr(coreToken: ethers.BigNumberish): string {
  const raw = CORE_SYSTEM_BASE.add(BigNumber.from(coreToken)).toHexString()
  return ethers.utils.getAddress(ethers.utils.hexZeroPad(raw, 20))
}

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

  // On a trade() bare revert, localize the failure. trade() is a thin wrapper:
  // validate params -> usdcPool.transact(proof,extData) (the ZK spend) -> bridge
  // -> CoreWriter. If the ZK spend reverts standalone, the proof/root/nullifier
  // (or extData routing) is bad. If it passes but trade() reverts, the failure
  // is in the bridge/CoreWriter wrapper. We also surface where the withdrawn
  // USDC is routed: extData.recipient MUST be the trader contract for the bridge
  // to have funds — a common front bug is putting the delivery address there.
  const diagnoseTrade = async (proof: any, extData: any, _params: any): Promise<Record<string, any>> => {
    const out: Record<string, any> = {}
    try {
      out.extRecipient = String(extData.recipient)
      out.extRecipientIsTrader = String(extData.recipient).toLowerCase() === cfg.trader
      out.feeRecipient = String(extData.feeRecipient)
      out.feeRecipientIsRelayer = String(extData.feeRecipient).toLowerCase() === relayer
      out.fee = ethers.BigNumber.from(extData.fee).toString()
      out.extAmount = ethers.BigNumber.from(extData.extAmount).toString()
      out.proofRoot = String(proof.root)
    } catch (e) {
      out.decodeError = extractRevert(e)
    }
    // is the proof's merkle root currently valid on the USDC pool?
    try {
      const p = new ethers.Contract(cfg.usdcPool, [...POOL_ABI, 'function isKnownRoot(bytes32) view returns (bool)'], provider)
      out.rootKnown = await p.isKnownRoot(proof.root)
    } catch (e) {
      out.rootKnownError = extractRevert(e)
    }
    // does the ZK spend itself pass, isolated from the bridge/CoreWriter wrapper?
    try {
      await pools.usdc.callStatic.transact(proof, extData, { from: relayer })
      out.poolTransact = 'OK'
    } catch (e) {
      out.poolTransact = 'REVERT: ' + extractRevert(e)
    }
    return out
  }

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
        const diag = await diagnoseTrade(proof, extData, params)
        console.error('[relay] /relay/trade sim revert:', reason, '| to:', cfg.trader, '|', JSON.stringify(diag))
        return c.json({ error: 'simulation_reverted', reason, diag }, 400)
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

  // Localize a transact (deposit/withdraw) revert: the usual culprits are a
  // stale merkle root (proof built against an old tree), an already-spent
  // nullifier (double-spend / re-submitted note), or extAmount/fee not matching
  // publicAmount. We can't trace, but root-known + spent-nullifier are readable.
  const diagnoseTransact = async (p: ethers.Contract, proof: any, extData: any): Promise<Record<string, any>> => {
    const out: Record<string, any> = {}
    try {
      out.root = String(proof.root)
      out.recipient = String(extData.recipient)
      out.extAmount = ethers.BigNumber.from(extData.extAmount).toString()
      out.fee = ethers.BigNumber.from(extData.fee).toString()
      out.feeRecipient = String(extData.feeRecipient)
      out.publicAmount = String(proof.publicAmount)
    } catch (e) {
      out.decodeError = extractRevert(e)
    }
    const probe = new ethers.Contract(
      p.address,
      ['function isKnownRoot(bytes32) view returns (bool)', 'function isSpent(bytes32) view returns (bool)'],
      provider,
    )
    try {
      out.rootKnown = await probe.isKnownRoot(proof.root)
    } catch (e) {
      out.rootKnownError = extractRevert(e)
    }
    try {
      out.nullifiersSpent = await Promise.all(
        (proof.inputNullifiers ?? []).map((n: string) => probe.isSpent(n).catch(() => 'n/a')),
      )
    } catch (e) {
      out.spentError = extractRevert(e)
    }
    return out
  }

  // Resolve the pool field to a key, accepting a label ('usdc'|'hype') or the
  // pool's on-chain address (the front sends the address on some routes).
  const resolvePoolKey = (pool: unknown): 'usdc' | 'hype' | null => {
    const v = String(pool ?? '').toLowerCase()
    if (v === 'usdc' || v === 'hype') return v
    if (v === cfg.usdcPool) return 'usdc'
    if (v === cfg.hypePool) return 'hype'
    return null
  }

  // Shielded deposit/withdraw — standard mixer transact, fee paid in-token.
  // Exposed as both /relay/transact and /relay/withdraw (same on-chain call).
  const handleTransact = async (c: any) => {
    try {
      const body = await c.req.json()
      const proof = body.proof ?? body.args
      const extData = body.extData ?? body.ext
      const key = resolvePoolKey(body.pool)
      if (!proof || !extData || !key) {
        return c.json(
          { error: "proof/extData required, pool must be 'usdc'|'hype' or a pool address", received: Object.keys(body ?? {}) },
          400,
        )
      }
      const fee = checkFee(extData, relayer, minFeeFor(key))
      if (!fee.ok) return c.json({ error: fee.error }, 400)
      const p = pools[key]
      try {
        await simulate(p, 'transact', [proof, extData])
      } catch (e) {
        const reason = extractRevert(e)
        const diag = await diagnoseTransact(p, proof, extData)
        console.error('[relay] /relay/withdraw|transact sim revert:', reason, '| pool:', key, '|', JSON.stringify(diag))
        return c.json({ error: 'simulation_reverted', reason, diag }, 400)
      }
      const tx = await send(p, 'transact', [proof, extData])
      await tx.wait(1)
      return c.json({ txHash: tx.hash })
    } catch (e) {
      return c.json({ error: 'relay_failed', reason: extractRevert(e) }, 500)
    }
  }
  app.post('/relay/transact', handleTransact)
  app.post('/relay/withdraw', handleTransact)

  // Gasless USDC deposit. The user has no HYPE for gas: they sign an EIP-2612
  // Permit (USDC allowance -> pool) + a deposit auth (binds them to their note)
  // off-chain, and the relayer pays gas and submits depositWithPermit. USDC only.
  app.post('/relay/deposit', async (c) => {
    try {
      const body = await c.req.json()
      const proof = body.proof ?? body.args // the front may name the ZK proof "args"
      const extData = body.extData ?? body.ext
      const permit = body.permit ?? body.auth ?? body.sigs
      if (!proof || !extData || !permit) {
        return c.json(
          { error: 'proof/extData/permit required', received: Object.keys(body ?? {}) },
          400,
        )
      }
      // A fee only has to go to the relayer when one is set (min defaults to 0).
      const hasFee = (() => {
        try {
          return BigNumber.from(extData.fee ?? 0).gt(0)
        } catch {
          return false
        }
      })()
      if (cfg.minFeeDeposit.gt(0) || hasFee) {
        const fee = checkFee(extData, relayer, cfg.minFeeDeposit)
        if (!fee.ok) return c.json({ error: fee.error }, 400)
      }
      const p = pools.usdc
      try {
        await simulate(p, 'depositWithPermit', [proof, extData, permit])
      } catch (e) {
        return c.json({ error: 'simulation_reverted', reason: extractRevert(e) }, 400)
      }
      const tx = await send(p, 'depositWithPermit', [proof, extData, permit])
      await tx.wait(1)
      return c.json({ txHash: tx.hash })
    } catch (e) {
      return c.json({ error: 'relay_failed', reason: extractRevert(e) }, 500)
    }
  })

  // Shielded withdraw straight to HyperCore spot. Mirrors /relay/deposit but the
  // other way: (a) pool.transact(proof,extData) unshields the funds to the owner;
  // (b) the owner's EIP-2612 Permit lets the relayer move them; (c) transferFrom
  // (value - bridgeFee) to the token's HyperCore system address (the spot bridge);
  // (d) transferFrom the bridgeFee to the relayer as gas comp.
  app.post('/relay/withdrawToCore', async (c) => {
    try {
      const body = await c.req.json()
      const proof = body.proof ?? body.args
      const extData = body.extData ?? body.ext
      const permit = body.permit ?? body.auth
      const key = resolvePoolKey(body.pool)
      const coreToken = body.coreToken
      if (!proof || !extData || !permit || !key || coreToken === undefined || coreToken === null) {
        return c.json(
          {
            error: "proof/extData/permit/coreToken required, pool must be 'usdc'|'hype' or a pool address",
            received: Object.keys(body ?? {}),
          },
          400,
        )
      }
      // The Permit must authorize the relayer (it is msg.sender of transferFrom).
      if (permit.spender && String(permit.spender).toLowerCase() !== relayer) {
        return c.json({ error: 'permit.spender must be the relayer', relayer }, 400)
      }
      // The withdrawn-token amount the owner permits must cover the bridge fee.
      let value: BigNumber
      try {
        value = BigNumber.from(permit.value)
      } catch {
        return c.json({ error: 'invalid permit.value' }, 400)
      }
      const bridgeAmount = value.sub(cfg.bridgeFee)
      if (bridgeAmount.lte(0)) {
        return c.json({ error: `permit.value ${value.toString()} must exceed bridgeFee ${cfg.bridgeFee.toString()}` }, 400)
      }
      // An in-note fee (paid to the relayer in-token) is optional here — the
      // relayer is normally paid via bridgeFee — but if one is set it must be ours.
      const hasNoteFee = (() => {
        try {
          return BigNumber.from(extData.fee ?? 0).gt(0)
        } catch {
          return false
        }
      })()
      if (minFeeFor(key).gt(0) || hasNoteFee) {
        const fee = checkFee(extData, relayer, minFeeFor(key))
        if (!fee.ok) return c.json({ error: fee.error }, 400)
      }

      const p = pools[key]
      // (a) unshield: pool.transact lands the funds at extData.recipient (the owner).
      try {
        await simulate(p, 'transact', [proof, extData])
      } catch (e) {
        const reason = extractRevert(e)
        const diag = await diagnoseTransact(p, proof, extData)
        console.error('[relay] /relay/withdrawToCore transact sim revert:', reason, '| pool:', key, '|', JSON.stringify(diag))
        return c.json({ error: 'simulation_reverted', reason, diag }, 400)
      }
      const withdrawTx = await send(p, 'transact', [proof, extData])
      await withdrawTx.wait(1)

      // The pool's underlying ERC20 is what the owner now holds and what we bridge.
      const tokenAddr: string = await p.token()
      const token = new ethers.Contract(tokenAddr, ERC20_PERMIT_ABI, wallet)

      try {
        // (b) permit: owner -> relayer allowance for `value`.
        const permitTx = await send(token, 'permit', [
          permit.owner,
          relayer,
          value,
          permit.deadline,
          permit.v,
          permit.r,
          permit.s,
        ])
        await permitTx.wait(1)

        // (c) bridge: transferFrom(owner -> systemAddr(coreToken), value - bridgeFee).
        const bridgeTx = await send(token, 'transferFrom', [permit.owner, systemAddr(coreToken), bridgeAmount])
        await bridgeTx.wait(1)

        // (d) relayer gas comp: transferFrom(owner -> relayer, bridgeFee).
        if (cfg.bridgeFee.gt(0)) {
          const feeTx = await send(token, 'transferFrom', [permit.owner, relayer, cfg.bridgeFee])
          await feeTx.wait(1)
        }

        return c.json({ withdrawTxHash: withdrawTx.hash, bridgeTxHash: bridgeTx.hash })
      } catch (e) {
        // The unshield already mined; surface that so the funds aren't presumed lost.
        const reason = extractRevert(e)
        console.error('[relay] /relay/withdrawToCore bridge leg failed after withdraw', withdrawTx.hash, ':', reason)
        return c.json({ error: 'bridge_failed', reason, withdrawTxHash: withdrawTx.hash }, 500)
      }
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
