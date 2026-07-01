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
import { TRADER_ABI, CORE_ABI, POOL_ABI, ERC20_PERMIT_ABI, CORE_WRITER, CORE_WRITER_ABI, CORE_DEPOSIT_ABI, SPOT_DEX, STATUS } from './abis'
import { checkFee } from './validate'
import {
  initRelayStore,
  recordTrade,
  openTradeIds,
  markDone,
  createSpotWithdraw,
  setSpotBridged,
  setSpotDone,
  openSpotWithdraws,
  getSpotWithdraw,
  bumpSpotAttempt,
} from './store'
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

// CoreWriter spot-send (action id 6): header (version 1 + 24-bit action id) then
// abi(address destination, uint64 coreToken, uint64 weiAmount). Mirrors the
// frontend bridge encoder / contracts' CoreWriterLib.
function encodeSpotSend(destination: string, coreToken: ethers.BigNumberish, weiAmount: ethers.BigNumberish): string {
  const header = ethers.utils.solidityPack(['uint8', 'uint24'], [1, 6])
  const body = ethers.utils.defaultAbiCoder.encode(
    ['address', 'uint64', 'uint64'],
    [destination, BigNumber.from(coreToken), BigNumber.from(weiAmount)],
  )
  return ethers.utils.hexConcat([header, body])
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

  // ---- HL_SPOT_BRIDGE hot wallet (for /relay/withdrawToCore) ----------------
  // A dedicated transit wallet. Funds for a "withdraw to HyperCore spot of an
  // arbitrary address" are unshielded TO this wallet, then it bridges them to
  // Core and spotSends to the destination. Because every user's funds transit
  // through the SAME wallet, the whole sequence is serialized (one job at a time)
  // and each job only forwards the exact Core balance delta its own bridge
  // credited — so we can never send another user's money. Optional: the route is
  // disabled until HL_SPOT_BRIDGE_PRIVATE_KEY is set.
  const bridgeKey = process.env.HL_SPOT_BRIDGE_PRIVATE_KEY
  const bridgeWallet = bridgeKey ? new ethers.Wallet(bridgeKey, provider) : null
  const bridgeAddr = bridgeWallet ? bridgeWallet.address.toLowerCase() : null
  const gasBridgeTransfer = envInt('GAS_BRIDGE_TRANSFER', 300_000)
  const gasBridgeSpotSend = envInt('GAS_BRIDGE_SPOTSEND', 2_000_000)
  const bridgePollMs = envInt('BRIDGE_CREDIT_POLL_MS', 3000)
  const bridgePollTries = envInt('BRIDGE_CREDIT_POLL_TRIES', 25)
  const spotMaxAttempts = envInt('SPOT_MAX_ATTEMPTS', 3)
  const spotResumeMs = envInt('SPOT_RESUME_MS', 30_000)
  // USDC (coreToken 0) bridges to Core via Circle's CoreDepositWallet.deposit(),
  // NOT the 0x2000+idx system-address transfer (that's for HYPE/HIP-1 tokens).
  // Defaults to the mainnet CoreDepositWallet; override via env.
  const coreDepositWallet =
    process.env.CORE_DEPOSIT_WALLET?.toLowerCase() ||
    (cfg.chainId === 999 ? '0x6b9e773128f453f5c2c60935ee2de2cbc5390a24' : '')

  // Independent nonce lock for the bridge wallet's own EVM txs (it's a separate
  // signer from the main relayer, so it needs its own serialized nonce).
  let bridgeLock: Promise<void> = Promise.resolve()
  let bridgeNonce: number | null = null
  async function bridgeSendTx(to: string, data: string, gasLimit: number): Promise<ethers.providers.TransactionResponse> {
    const prev = bridgeLock
    let release!: () => void
    bridgeLock = new Promise<void>((r) => (release = r))
    await prev
    try {
      if (bridgeNonce === null) bridgeNonce = await provider.getTransactionCount(bridgeAddr!, 'pending')
      try {
        const tx = await bridgeWallet!.sendTransaction({ to, data, gasLimit, nonce: bridgeNonce })
        bridgeNonce = (bridgeNonce as number) + 1
        return tx
      } catch (e) {
        bridgeNonce = null
        throw e
      }
    } finally {
      release()
    }
  }

  // Whole-job queue: serializes each withdrawToCore end-to-end so the per-job
  // balance deltas (EVM received, Core credited) are never corrupted by a
  // concurrent job sharing the bridge wallet.
  let jobLock: Promise<void> = Promise.resolve()
  async function withJobLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = jobLock
    let release!: () => void
    jobLock = new Promise<void>((r) => (release = r))
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }

  // Core spot-balance reader (HyperCoreView / gateway). Cached.
  let coreRead: ethers.Contract | null = null
  const getCoreRead = async (): Promise<ethers.Contract> => {
    if (coreRead) return coreRead
    const addr = cfg.coreGateway ?? (await trader.core())
    coreRead = new ethers.Contract(addr, CORE_ABI, provider)
    return coreRead
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  // Finish a spot-withdraw job's on-chain legs idempotently from its journal
  // state: (bridge if not yet bridged) → wait for Core credit → spotSend the
  // exact credited delta to the destination. Used by the route AND the resume
  // worker, so a job interrupted mid-flight is completed to the user's address
  // automatically — no manual recovery. MUST be called holding withJobLock.
  type SpotJob = {
    id: string
    token: string
    coreToken: ethers.BigNumberish
    destination: string
    evmReceived: string
    coreBefore: string
    status: 'unshielded' | 'bridged' | 'done'
    bridgeTx: string | null
  }
  async function runSpotLegs(job: SpotJob): Promise<{ bridgeTxHash: string | null; spotSendTxHash: string; amount: string }> {
    const token = new ethers.Contract(job.token, ERC20_PERMIT_ABI, provider)
    const core = await getCoreRead()
    const coreBefore = BigNumber.from(job.coreBefore)
    let bridgeTxHash = job.bridgeTx

    if (job.status === 'unshielded') {
      // If the ERC20 is still here, bridge it. If it already left (a pre-crash
      // bridge tx that wasn't journaled), skip straight to the credit/spotSend.
      const bal: BigNumber = await token.balanceOf(bridgeAddr!)
      const amt = BigNumber.from(job.evmReceived)
      // USDC (coreToken 0) bridges via Circle's CoreDepositWallet.deposit(), not a
      // transfer to the 0x2000+idx system address. Everything else uses the
      // system-address transfer (HYPE/HIP-1 tokens).
      const isUsdc = BigNumber.from(job.coreToken).isZero()
      if (bal.gte(amt)) {
        if (isUsdc) {
          if (!coreDepositWallet) throw new Error('CORE_DEPOSIT_WALLET not configured for USDC bridge')
          const cdw = new ethers.Contract(coreDepositWallet, CORE_DEPOSIT_ABI, bridgeWallet!)
          // approve the CoreDepositWallet to pull the USDC, then deposit to spot.
          const approveData = token.interface.encodeFunctionData('approve', [coreDepositWallet, amt])
          const aTx = await bridgeSendTx(job.token, approveData, gasBridgeTransfer)
          await aTx.wait(1)
          try {
            await cdw.callStatic.deposit(amt, SPOT_DEX, { from: bridgeAddr! })
          } catch (e) {
            throw new Error('CoreDepositWallet.deposit would revert: ' + extractRevert(e))
          }
          const depositData = cdw.interface.encodeFunctionData('deposit', [amt, SPOT_DEX])
          const tx = await bridgeSendTx(coreDepositWallet, depositData, gasBridgeTransfer)
          await tx.wait(1)
          bridgeTxHash = tx.hash
        } else {
          // Pre-simulate so a permanently-reverting transfer fails WITHOUT sending
          // a tx — otherwise every retry burns gas on a reverted tx.
          try {
            await token.callStatic.transfer(systemAddr(job.coreToken), amt, { from: bridgeAddr! })
          } catch (e) {
            throw new Error('bridge transfer would revert: ' + extractRevert(e))
          }
          const data = token.interface.encodeFunctionData('transfer', [systemAddr(job.coreToken), amt])
          const tx = await bridgeSendTx(job.token, data, gasBridgeTransfer)
          await tx.wait(1)
          bridgeTxHash = tx.hash
        }
      }
      await setSpotBridged(job.id, bridgeTxHash ?? 'recovered')
    }

    // Wait for HyperCore to credit the bridge wallet, then forward the delta.
    let credited = BigNumber.from(0)
    for (let i = 0; i < bridgePollTries; i++) {
      await sleep(bridgePollMs)
      const now: BigNumber = await core.spotBalance(bridgeAddr!, BigNumber.from(job.coreToken))
      if (now.gt(coreBefore)) {
        credited = now.sub(coreBefore)
        break
      }
    }
    if (credited.lte(0)) throw new Error('Core balance not credited in time')

    const action = encodeSpotSend(job.destination, job.coreToken, credited)
    const sendData = new ethers.utils.Interface(CORE_WRITER_ABI).encodeFunctionData('sendRawAction', [action])
    const spotTx = await bridgeSendTx(CORE_WRITER, sendData, gasBridgeSpotSend)
    await spotTx.wait(1)
    await setSpotDone(job.id, spotTx.hash)
    return { bridgeTxHash, spotSendTxHash: spotTx.hash, amount: credited.toString() }
  }

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
  app.get('/relay/health', (c) => c.json({ ok: true, relayer, trader: cfg.trader, spotBridge: bridgeAddr }))

  app.get('/relay/info', (c) =>
    c.json({
      relayer,
      trader: cfg.trader,
      // The HL_SPOT_BRIDGE wallet — the front MUST set extData.recipient to this
      // for /relay/withdrawToCore (funds transit through it). null = route off.
      spotBridge: bridgeAddr,
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
      // Pre-check ONLY the ZK spend (usdcPool.transact is simulatable via eth_call).
      // We do NOT callStatic the whole trade(): its fund-and-buy leg touches
      // HyperCore system contracts (CoreDepositWallet.deposit + CoreWriter) that
      // aren't simulatable via eth_call — a full callStatic gives a false bare
      // revert (data=0x) even when the real tx would succeed. So validate the ZK
      // spend here, then send with a fixed gas limit (skips estimateGas) and
      // surface the real on-chain outcome.
      try {
        await pools.usdc.callStatic.transact(proof, extData, { from: relayer })
      } catch (e) {
        const reason = extractRevert(e)
        console.error('[relay] /relay/trade ZK pre-check revert:', reason)
        return c.json({ error: 'simulation_reverted', reason, stage: 'zk_spend' }, 400)
      }
      let tx: ethers.providers.TransactionResponse
      try {
        tx = await send(trader, 'trade', [proof, extData, params], cfg.gasTrade)
      } catch (e) {
        const reason = extractRevert(e)
        const diag = await diagnoseTrade(proof, extData, params)
        console.error('[relay] /relay/trade send failed:', reason, '|', JSON.stringify(diag))
        return c.json({ error: 'trade_send_failed', reason, diag }, 400)
      }
      let receipt: ethers.providers.TransactionReceipt
      try {
        receipt = await tx.wait(1)
      } catch (e) {
        // Mined but reverted (atomic — the ZK spend rolled back too, so no funds
        // moved; only gas spent). This is a REAL contract revert, not a sim artifact.
        console.error('[relay] /relay/trade reverted on-chain:', tx.hash, extractRevert(e))
        return c.json({ error: 'trade_reverted_onchain', reason: extractRevert(e), txHash: tx.hash }, 400)
      }
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

  // Shielded withdraw straight to a HyperCore spot address the user does NOT need
  // to control (no permit — permit can't authorize sending to a foreign wallet).
  // The funds transit through the shared HL_SPOT_BRIDGE hot wallet:
  //   (a) pool.transact(proof,extData) unshields TO the bridge wallet
  //       (extData.recipient MUST be the bridge wallet);
  //   (b) bridge wallet transfer()s the received ERC20 to systemAddr(coreToken)
  //       → credits the bridge wallet's Core spot balance;
  //   (c) once Core credits (poll the spot-balance delta), the bridge wallet
  //       CoreWriter-spotSends exactly that delta to the destination.
  // The whole job is serialized (withJobLock) and only forwards its OWN measured
  // delta, so one user's funds can never be sent to another's destination.
  app.post('/relay/withdrawToCore', async (c) => {
    try {
      const body = await c.req.json()
      const proof = body.proof ?? body.args
      const extData = body.extData ?? body.ext
      const key = resolvePoolKey(body.pool)
      const coreToken = body.coreToken
      const destination = body.destination ?? body.to
      if (
        !proof ||
        !extData ||
        !key ||
        coreToken === undefined ||
        coreToken === null ||
        !destination
      ) {
        return c.json(
          {
            error: "proof/extData/coreToken/destination required, pool must be 'usdc'|'hype' or a pool address",
            received: Object.keys(body ?? {}),
          },
          400,
        )
      }
      if (!bridgeWallet || !bridgeAddr) {
        return c.json({ error: 'HL_SPOT_BRIDGE_PRIVATE_KEY not configured' }, 503)
      }
      if (!ethers.utils.isAddress(destination)) {
        return c.json({ error: 'invalid destination address' }, 400)
      }
      // SECURITY: the unshield MUST land at the bridge wallet. If extData.recipient
      // were anything else, the funds wouldn't be here and the spotSend below would
      // forward some OTHER user's transiting balance.
      if (String(extData.recipient).toLowerCase() !== bridgeAddr) {
        return c.json({ error: 'extData.recipient must be the HL_SPOT_BRIDGE wallet', bridge: bridgeAddr }, 400)
      }
      // Optional in-note fee (paid to the relayer in-token) — if set, must be ours.
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
      // Simulate the unshield up front so a bad proof fails fast (no lock held).
      try {
        await simulate(p, 'transact', [proof, extData])
      } catch (e) {
        const reason = extractRevert(e)
        const diag = await diagnoseTransact(p, proof, extData)
        console.error('[relay] /relay/withdrawToCore transact sim revert:', reason, '| pool:', key, '|', JSON.stringify(diag))
        return c.json({ error: 'simulation_reverted', reason, diag }, 400)
      }

      const tokenAddr: string = await p.token()
      const token = new ethers.Contract(tokenAddr, ERC20_PERMIT_ABI, provider)
      const core = await getCoreRead()

      // Serialize the whole job so the EVM-received and Core-credited deltas are
      // measured against a quiet bridge wallet (no concurrent job interleaving).
      return await withJobLock(async () => {
        // (a) unshield -> bridge wallet. The amount received is taken from THIS
        // tx's own Transfer(_, bridge, value) logs — authoritative per-tx, so two
        // jobs can never attribute each other's funds (a balance snapshot could
        // be skewed by anything else hitting the wallet; a receipt can't).
        const coreBefore: BigNumber = await core.spotBalance(bridgeAddr, BigNumber.from(coreToken))
        const withdrawTx = await send(p, 'transact', [proof, extData])
        const receipt = await withdrawTx.wait(1)
        let received = BigNumber.from(0)
        for (const log of receipt.logs ?? []) {
          if (log.address.toLowerCase() !== tokenAddr.toLowerCase()) continue
          try {
            const parsed = token.interface.parseLog(log)
            if (parsed.name === 'Transfer' && String(parsed.args.to).toLowerCase() === bridgeAddr) {
              received = received.add(parsed.args.value)
            }
          } catch {
            /* not a Transfer log */
          }
        }
        if (received.lte(0)) {
          console.error('[relay] /relay/withdrawToCore: tx delivered no funds to bridge', withdrawTx.hash)
          return c.json({ error: 'bridge_failed', reason: 'withdraw tx delivered no funds to the bridge wallet', withdrawTxHash: withdrawTx.hash }, 500)
        }

        // Journal the job BEFORE the bridge/spotSend legs so a crash leaves a
        // resumable record (destination + amounts) the worker can finish.
        const jobId = await createSpotWithdraw({
          bridge: bridgeAddr,
          pool: key,
          token: tokenAddr,
          coreToken: BigNumber.from(coreToken).toString(),
          destination,
          evmReceived: received.toString(),
          coreBefore: coreBefore.toString(),
          withdrawTx: withdrawTx.hash,
        })

        try {
          const r = await runSpotLegs({
            id: jobId,
            token: tokenAddr,
            coreToken,
            destination,
            evmReceived: received.toString(),
            coreBefore: coreBefore.toString(),
            status: 'unshielded',
            bridgeTx: null,
          })
          return c.json({ withdrawTxHash: withdrawTx.hash, ...r, destination })
        } catch (e) {
          // Funds are safely at the bridge wallet and the job is journaled — the
          // resume worker will finish it to `destination`. Not lost, not manual.
          const reason = extractRevert(e)
          console.error('[relay] /relay/withdrawToCore legs pending (will resume) job', jobId, ':', reason)
          return c.json({ status: 'pending', reason, withdrawTxHash: withdrawTx.hash, jobId, destination }, 202)
        }
      })
    } catch (e) {
      return c.json({ error: 'relay_failed', reason: extractRevert(e) }, 500)
    }
  })

  // Poll a spot-withdraw job (the front uses this after a 202 pending response).
  app.get('/relay/withdrawToCore/:id', async (c) => {
    try {
      const row = await getSpotWithdraw(c.req.param('id'))
      if (!row) return c.json({ error: 'not found' }, 404)
      return c.json({
        id: row.id,
        status: row.status, // unshielded | bridged | done | failed
        destination: row.destination,
        amount: row.evm_received,
        withdrawTxHash: row.withdraw_tx,
        bridgeTxHash: row.bridge_tx,
        spotSendTxHash: row.spotsend_tx,
        attempts: row.attempts,
        lastError: row.last_error,
      })
    } catch (e) {
      return c.json({ error: 'lookup_failed', reason: extractRevert(e) }, 500)
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

  // Resume any spot-withdraw whose bridge/spotSend legs didn't finish (crash,
  // RPC hiccup, Core credit lag). Runs under withJobLock and re-reads the open
  // set INSIDE the lock, so it never races a live /relay/withdrawToCore request
  // nor double-sends. Each job is finished to its journaled destination.
  const spotResumeTick = async (): Promise<void> => {
    if (!bridgeAddr) return
    await withJobLock(async () => {
      let jobs
      try {
        jobs = await openSpotWithdraws(bridgeAddr)
      } catch (e) {
        console.error('[relay] spot resume: list failed:', extractRevert(e))
        return
      }
      for (const j of jobs) {
        try {
          const r = await runSpotLegs({
            id: j.id,
            token: j.token,
            coreToken: j.core_token,
            destination: j.destination,
            evmReceived: j.evm_received,
            coreBefore: j.core_before,
            status: j.status as SpotJob['status'],
            bridgeTx: j.bridge_tx,
          })
          console.log(`[relay] resumed spot withdraw ${j.id} -> ${j.destination} (${r.amount}) spotSend ${r.spotSendTxHash}`)
        } catch (e) {
          const reason = extractRevert(e)
          // Count the attempt; park as 'failed' after the cap so we stop retrying
          // (and stop burning gas / spamming) on a permanently-stuck job.
          await bumpSpotAttempt(j.id, reason, spotMaxAttempts).catch(() => {})
          const parked = Number(j.attempts) + 1 >= spotMaxAttempts
          console.error(`[relay] spot resume ${j.id} ${parked ? 'PARKED (failed)' : 'pending'}:`, reason)
        }
      }
    })
  }

  initRelayStore()
    .then(() => {
      setInterval(workerTick, cfg.pollMs)
      if (bridgeWallet) setInterval(spotResumeTick, spotResumeMs)
      console.log(
        `Relayer enabled — signer ${relayer}, trader ${cfg.trader}, delivery worker every ${cfg.pollMs}ms` +
          (bridgeWallet ? `, spot bridge ${bridgeAddr} (resume every ${spotResumeMs}ms, max ${spotMaxAttempts} tries)` : ''),
      )
    })
    .catch((e) => console.error('[relay] store init failed:', extractRevert(e)))

  return true
}
