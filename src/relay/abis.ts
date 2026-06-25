// Contract surface the v1 relayer talks to.
//
// NOTE: the v1 HyperTrader exposes a one-shot trade() + a permissionless
// deliver(tradeId) (no shielded settle, no output pool). These ABIs must match
// whatever you deploy — see README "Contract surface required". The two-step
// shielded flow (initiate/settle/cancel/sell) lives on the `v2` branch.

const PROOF =
  'tuple(uint256[2] pA, uint256[2][2] pB, uint256[2] pC, bytes32 root, bytes32[2] inputNullifiers, bytes32[2] outputCommitments, uint256 publicAmount, bytes32 extDataHash)'
const EXTDATA =
  'tuple(address recipient, int256 extAmount, address feeRecipient, uint256 fee, bytes encryptedOutput1, bytes encryptedOutput2)'
// Trade params built off-chain by the front (size/limitPx already in core units,
// the recipient address where the bought asset is delivered, etc.).
const PARAMS =
  'tuple(uint32 asset, uint64 size, uint64 limitPx, uint64 assetCoreToken, address recipient, uint128 cloid, uint64 deadline)'

// trades(id) getter tuple — MUST match the deployed Trade struct order:
// (account, recipient, assetCoreToken, size, venue, deadline, status).
const TRADE =
  'tuple(address account, address recipient, uint64 assetCoreToken, uint64 size, uint32 venue, uint64 deadline, uint8 status)'

export const TRADER_ABI = [
  `function trade(${PROOF} proof, ${EXTDATA} extData, ${PARAMS} p) returns (uint256)`,
  'function deliver(uint256 tradeId)',
  'function cancel(uint256 tradeId)',
  'function core() view returns (address)',
  `function trades(uint256) view returns (${TRADE})`,
  'event Traded(uint256 indexed tradeId, address account, uint64 assetCoreToken, uint64 size, address recipient, uint128 cloid)',
  'event Cancelled(uint256 indexed tradeId, address recipient, uint256 usdcRefunded, uint256 assetRefunded)',
]

// Trade.status enum (must match the contract): 0 None, 1 Open, 2 Delivered, 3 Cancelled.
export const STATUS = { None: 0, Open: 1, Delivered: 2, Cancelled: 3 } as const

// HyperCore read gateway (trader.core()). spotBalance is the synchronous fill check.
export const CORE_ABI = ['function spotBalance(address account, uint64 token) view returns (uint64)']

export const POOL_ABI = [`function transact(${PROOF} args, ${EXTDATA} extData)`]
