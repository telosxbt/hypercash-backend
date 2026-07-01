// Contract surface the v1 relayer talks to — aligned to the deployed v1 ABI
// (HyperTrader trade/deliver/cancel + Core gateway + pools). The two-step
// shielded flow lives on the `v2` branch.

const PROOF =
  'tuple(uint256[2] pA,uint256[2][2] pB,uint256[2] pC,bytes32 root,bytes32[2] inputNullifiers,bytes32[2] outputCommitments,uint256 publicAmount,bytes32 extDataHash)'
const EXTDATA =
  'tuple(address recipient,int256 extAmount,address feeRecipient,uint256 fee,bytes encryptedOutput1,bytes encryptedOutput2)'
// TradeParams — field order MUST match the DEPLOYED struct exactly. The deployed
// HyperTrader.TradeParams has 7 fields and NO `venue`; encoding an extra field
// mismatches the calldata layout and makes trade() bare-revert during ABI decode.
const PARAMS =
  'tuple(uint32 asset,uint64 assetCoreToken,uint64 size,uint64 limitPx,uint128 cloid,address recipient,uint64 deadline)'

export const TRADER_ABI = [
  // writes relayed by the relayer (it signs + pays HYPE gas)
  `function trade(${PROOF} proof, ${EXTDATA} extData, ${PARAMS} p) returns (uint256 tradeId)`,
  'function deliver(uint256 tradeId)',
  'function cancel(uint256 tradeId)',
  // reads (deliver/cancel worker)
  'function trades(uint256) view returns (address account,address recipient,uint64 assetCoreToken,uint64 size,uint64 deadline,uint8 status)',
  'function nextTradeId() view returns (uint256)',
  'function tradeAccountOf(uint256 tradeId) view returns (address)',
  'function core() view returns (address)',
  'function coreWriter() view returns (address)',
  'function usdcPool() view returns (address)',
  // events (must match the deployed contract exactly — no `venue`)
  'event Traded(uint256 indexed tradeId,address account,address recipient,uint32 asset,uint64 assetCoreToken,uint64 size,uint64 limitPx,uint128 cloid,uint256 usdcIn)',
  'event Delivered(uint256 indexed tradeId,address recipient,uint64 assetCoreToken,uint64 size)',
  'event Cancelled(uint256 indexed tradeId,address recipient,uint64 usdcRefunded,uint64 assetRefunded)',
]

// Core read gateway (trader.core()) — synchronous fill detection.
export const CORE_ABI = [
  'function spotBalance(address account,uint64 coreToken) view returns (uint64)',
  'function szToWei(uint64 coreToken,uint64 sz) view returns (uint64)',
]

// Gasless deposit permit bundle (USDC only). The user signs two things off-chain
// (zero gas): an EIP-2612 Permit (USDC allowance -> pool) and a deposit auth that
// binds them to their note (commitments + extAmount + deadline). The relayer pays
// gas and submits depositWithPermit. Field order MUST match the deployed struct.
const PERMIT =
  'tuple(address owner,uint256 value,uint256 deadline,uint8 permitV,bytes32 permitR,bytes32 permitS,uint8 authV,bytes32 authR,bytes32 authS)'

export const POOL_ABI = [
  `function transact(${PROOF} _args, ${EXTDATA} _extData)`,
  `function depositWithPermit(${PROOF} _args, ${EXTDATA} _extData, ${PERMIT} _permit)`,
  'function token() view returns (address)',
]

// Underlying pool ERC20. /relay/withdrawToCore unshields to the HL_SPOT_BRIDGE
// hot wallet, which then transfer()s the funds to the HyperCore system address
// (the spot bridge) and spotSends them on Core to the destination.
export const ERC20_PERMIT_ABI = [
  'function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
  'function approve(address spender,uint256 amount) returns (bool)',
  'function transfer(address to,uint256 amount) returns (bool)',
  'function transferFrom(address from,address to,uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function nonces(address owner) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]

// Circle's CoreDepositWallet — the USDC HyperEVM->HyperCore bridge. USDC is NOT
// bridged by transferring to the 0x2000+idx system address (that's HYPE/other
// HIP-1 tokens); instead you approve native USDC then call deposit(). See
// https://docs.chainstack.com/docs/hyperliquid-bridging-usdc
//   destinationDex: 0 = perps, 4294967295 (uint32 max) = spot.
export const CORE_DEPOSIT_ABI = ['function deposit(uint256 amount, uint32 destinationDex)']
export const SPOT_DEX = 4294967295

// CoreWriter (HyperCore system contract) — spot-send action (id 6) lets the
// bridge wallet forward its Core spot balance to an arbitrary destination.
export const CORE_WRITER = '0x3333333333333333333333333333333333333333'
export const CORE_WRITER_ABI = ['function sendRawAction(bytes data)']

// Trade.status enum (matches the contract): 0 None, 1 Open, 2 Delivered, 3 Cancelled.
export const STATUS = { None: 0, Open: 1, Delivered: 2, Cancelled: 3 } as const
