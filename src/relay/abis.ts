// Contract surface the v1 relayer talks to — aligned to the deployed v1 ABI
// (HyperTrader trade/deliver/cancel + Core gateway + pools). The two-step
// shielded flow lives on the `v2` branch.

const PROOF =
  'tuple(uint256[2] pA,uint256[2][2] pB,uint256[2] pC,bytes32 root,bytes32[2] inputNullifiers,bytes32[2] outputCommitments,uint256 publicAmount,bytes32 extDataHash)'
const EXTDATA =
  'tuple(address recipient,int256 extAmount,address feeRecipient,uint256 fee,bytes encryptedOutput1,bytes encryptedOutput2)'
// TradeParams — field order MUST match the deployed struct (front sends `p` by name).
const PARAMS =
  'tuple(uint32 asset,uint64 assetCoreToken,uint64 size,uint64 limitPx,uint128 cloid,address recipient,uint8 venue,uint64 deadline)'

export const TRADER_ABI = [
  // writes relayed by the relayer (it signs + pays HYPE gas)
  `function trade(${PROOF} proof, ${EXTDATA} extData, ${PARAMS} p) returns (uint256 tradeId)`,
  'function deliver(uint256 tradeId)',
  'function cancel(uint256 tradeId)',
  // reads (deliver/cancel worker)
  'function trades(uint256) view returns (address account,address recipient,uint64 assetCoreToken,uint64 size,uint8 venue,uint64 deadline,uint8 status)',
  'function nextTradeId() view returns (uint256)',
  'function tradeAccountOf(uint256 tradeId) view returns (address)',
  'function core() view returns (address)',
  'function coreWriter() view returns (address)',
  'function usdcPool() view returns (address)',
  // events
  'event Traded(uint256 indexed tradeId,address account,address recipient,uint32 asset,uint64 assetCoreToken,uint64 size,uint64 limitPx,uint128 cloid,uint256 usdcIn,uint8 venue)',
  'event Delivered(uint256 indexed tradeId,address recipient,uint64 assetCoreToken,uint64 size,uint8 venue)',
  'event Cancelled(uint256 indexed tradeId,address recipient,uint64 usdcRefunded,uint64 assetRefunded)',
]

// Core read gateway (trader.core()) — synchronous fill detection.
export const CORE_ABI = [
  'function spotBalance(address account,uint64 coreToken) view returns (uint64)',
  'function szToWei(uint64 coreToken,uint64 sz) view returns (uint64)',
]

export const POOL_ABI = [
  `function transact(${PROOF} _args, ${EXTDATA} _extData)`,
  'function token() view returns (address)',
]

// Trade.status enum (matches the contract): 0 None, 1 Open, 2 Delivered, 3 Cancelled.
export const STATUS = { None: 0, Open: 1, Delivered: 2, Cancelled: 3 } as const
