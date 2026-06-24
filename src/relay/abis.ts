// Contract surface the relayer talks to. Mirrors HyperTrader / ERCPool.
//
// NOTE: the spec describes both buy and sell flows and settle/cancel that take a
// (tradeId, proof, ext) triple with a BTC fee. The current feat/hypertrade
// contract only has the buy side and settleTrade(tradeId)/cancelTrade(tradeId)
// with no proof/ext, and adapter.orderStatus is a stub returning (0,0). Keep
// these ABIs in sync with whatever you actually deploy — see README "Contract
// surface required".

const PROOF =
  'tuple(uint256[2] pA, uint256[2][2] pB, uint256[2] pC, bytes32 root, bytes32[2] inputNullifiers, bytes32[2] outputCommitments, uint256 publicAmount, bytes32 extDataHash)'
const EXTDATA =
  'tuple(address recipient, int256 extAmount, address feeRecipient, uint256 fee, bytes encryptedOutput1, bytes encryptedOutput2)'
const PARAMS =
  'tuple(uint64 size, uint64 limitPx, uint64 deadline, uint128 cloid, bytes32 btcCommitment, bytes32 btcCommitment2, bytes32 refundCommitment, bytes encryptedOutput1, bytes encryptedOutput2)'

// trades(id)/sells(id) public-mapping getter return tuple (current Trade layout).
const TRADE =
  'tuple(address initiator, uint256 usdcIn, uint64 size, uint64 limitPx, uint128 cloid, uint64 deadline, bytes32 btcCommitment, bytes32 btcCommitment2, bytes32 refundCommitment, uint8 status, bytes encryptedOutput1, bytes encryptedOutput2)'

export const TRADER_ABI = [
  `function initiateTrade(${PROOF} proof, ${EXTDATA} extData, ${PARAMS} p) returns (uint256)`,
  `function initiateSell(${PROOF} proof, ${EXTDATA} extData, ${PARAMS} p) returns (uint256)`,
  `function settleTrade(uint256 tradeId, ${PROOF} proof, ${EXTDATA} ext)`,
  `function settleSell(uint256 tradeId, ${PROOF} proof, ${EXTDATA} ext)`,
  `function cancelTrade(uint256 tradeId, ${PROOF} proof, ${EXTDATA} ext)`,
  `function cancelSell(uint256 tradeId, ${PROOF} proof, ${EXTDATA} ext)`,
  `function trades(uint256) view returns (${TRADE})`,
  `function sells(uint256) view returns (${TRADE})`,
  'event TradeInitiated(uint256 indexed tradeId, uint256 usdcIn, uint64 size, uint64 limitPx, uint128 cloid)',
  'event SellInitiated(uint256 indexed tradeId, uint256 btcIn, uint64 size, uint64 limitPx, uint128 cloid)',
]

export const ADAPTER_ABI = [
  'function orderStatus(uint128 cloid) view returns (uint64 filledSize, uint64 openSize)',
]

export const POOL_ABI = [
  `function transact(${PROOF} args, ${EXTDATA} extData)`,
]

// Trade.status enum
export const STATUS = { None: 0, Open: 1, Settled: 2, Cancelled: 3 } as const
