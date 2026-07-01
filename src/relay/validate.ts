// Pure validation helpers (unit-tested without a chain).
import { BigNumber } from 'ethers'

export interface ExtDataLike {
  feeRecipient?: string
  fee?: string | number
  [k: string]: unknown
}

export interface FeeCheck {
  ok: boolean
  error?: string
}

/**
 * The relayer only submits txs that pay IT a fee >= the minimum, so it never
 * loses gas. The fee + recipient live in the ZK note's ExtData (fee, feeRecipient).
 */
export function checkFee(ext: ExtDataLike | undefined, relayer: string, minFee: BigNumber): FeeCheck {
  if (!ext) return { ok: false, error: 'missing extData' }
  // The deployed pool enforces its own protocol fee (feeBps → protocolFeeRecipient);
  // when no relayer fee is required (minFee 0) and the note carries no fee, there's
  // nothing to validate here — let the pool's on-chain check govern the fee.
  let feeVal: BigNumber
  try {
    feeVal = BigNumber.from(ext.fee ?? 0)
  } catch {
    return { ok: false, error: 'invalid fee' }
  }
  if (minFee.lte(0) && feeVal.isZero()) return { ok: true }
  const recipient = String(ext.feeRecipient ?? '').toLowerCase()
  if (!recipient || recipient !== relayer.toLowerCase()) {
    return { ok: false, error: 'feeRecipient is not the relayer' }
  }
  let fee: BigNumber
  try {
    fee = BigNumber.from(ext.fee ?? 0)
  } catch {
    return { ok: false, error: 'invalid fee' }
  }
  if (fee.lt(minFee)) {
    return { ok: false, error: `fee ${fee.toString()} below minimum ${minFee.toString()}` }
  }
  return { ok: true }
}
