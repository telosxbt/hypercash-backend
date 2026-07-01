// Turn the frontend's human-readable order into the on-chain TradeParams tuple.
// The front sends { coin, recipient, usdcIn, size, szDecimals, limitPx, venue,
// deadline } with size/limitPx human-readable; the relayer maps coin -> HyperCore
// asset + formats sizes (its own design choice, #596).
import { ethers, BigNumber } from 'ethers'

// HL MAINNET spot mapping for the v1 buy assets (from spotMeta, chain 999):
//   asset          = order asset id (10000 + spot universe index of the X/USDC pair)
//   assetCoreToken = HyperCore spot token index (for spotBalance/delivery)
//   szDecimals     = size decimals
// NB: these are MAINNET ids — testnet used entirely different ones (ETH 11137/1242,
// BTC 11054/1129, HYPE 11035/1105), which made trade() early-revert on mainnet.
export const COIN_MAP: Record<string, { asset: number; assetCoreToken: number; szDecimals: number }> = {
  ETH: { asset: 10151, assetCoreToken: 221, szDecimals: 4 }, // UETH/USDC (@151)
  BTC: { asset: 10142, assetCoreToken: 197, szDecimals: 5 }, // UBTC/USDC (@142)
  HYPE: { asset: 10107, assetCoreToken: 150, szDecimals: 2 }, // HYPE/USDC (@107)
}

// HyperCore spot price integer = price * 10^(8 - szDecimals)  (spot MAX_DECIMALS = 8).
const PX_MAX_DECIMALS = 8

export interface HumanOrder {
  coin: string
  recipient: string
  size: string | number
  limitPx: string | number
  venue?: number
  deadline?: string | number
  szDecimals?: number
}

// Matches the deployed HyperTrader.TradeParams exactly (7 fields, no venue).
export interface TradeParams {
  asset: number
  assetCoreToken: number
  size: BigNumber
  limitPx: BigNumber
  cloid: BigNumber
  recipient: string
  deadline: BigNumber
}

/** True if the payload is a human order (needs formatting) vs a ready tuple. */
export function isHumanOrder(p: any): boolean {
  return !!p && typeof p === 'object' && typeof p.coin === 'string'
}

export function randomCloid(): BigNumber {
  return BigNumber.from(ethers.utils.randomBytes(16)) // uint128
}

export function buildTradeParams(order: HumanOrder, cloid: BigNumber): TradeParams {
  const coin = String(order.coin).toUpperCase()
  const m = COIN_MAP[coin]
  if (!m) throw new Error(`unknown coin "${order.coin}"`)
  if (!ethers.utils.isAddress(order.recipient)) throw new Error('invalid recipient')

  const szDec = m.szDecimals
  // parseUnits handles the decimal string safely (no float drift) and rejects
  // over-precise inputs.
  const size = ethers.utils.parseUnits(String(order.size), szDec)
  const limitPx = ethers.utils.parseUnits(String(order.limitPx), PX_MAX_DECIMALS - szDec)
  if (size.lte(0)) throw new Error('size must be > 0')
  if (limitPx.lte(0)) throw new Error('limitPx must be > 0')

  return {
    asset: m.asset,
    assetCoreToken: m.assetCoreToken,
    size,
    limitPx,
    cloid,
    recipient: order.recipient,
    deadline: BigNumber.from(order.deadline ?? 0),
  }
}
