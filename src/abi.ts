// Event signatures + a decoder for the two pool events we index.
import { ethers } from 'ethers'

export const POOL_EVENTS = [
  'event NewCommitment(bytes32 commitment, uint256 index, bytes encryptedOutput)',
  'event NewNullifier(bytes32 nullifier)',
]

export const iface = new ethers.utils.Interface(POOL_EVENTS)

// topic0 (keccak of the canonical signature). NewCommitment is given in the spec;
// we compute both at build time rather than hardcoding (spec §1).
export const NEW_COMMITMENT_TOPIC = iface.getEventTopic('NewCommitment')
export const NEW_NULLIFIER_TOPIC = iface.getEventTopic('NewNullifier')

// Sanity: the spec pins the NewCommitment topic — assert we match it.
export const EXPECTED_NEW_COMMITMENT_TOPIC =
  '0xf3843eddcfcac65d12d9f26261dab50671fdbf5dc44441816c8bbdace2411afd'

export type DecodedLog =
  | {
      kind: 'commitment'
      commitment: string
      leafIndex: number
      encryptedOutput: string
      blockNumber: number
      txHash: string
      logIndex: number
    }
  | {
      kind: 'nullifier'
      nullifier: string
      blockNumber: number
      txHash: string
      logIndex: number
    }

export interface RawLog {
  topics: string[]
  data: string
  blockNumber: number
  transactionHash: string
  logIndex: number
}

/** Decode one raw log into a typed event, or null if it's not one of ours. */
export function decodeLog(log: RawLog): DecodedLog | null {
  const topic0 = log.topics[0]?.toLowerCase()
  if (topic0 === NEW_COMMITMENT_TOPIC.toLowerCase()) {
    const p = iface.decodeEventLog('NewCommitment', log.data, log.topics)
    return {
      kind: 'commitment',
      commitment: (p.commitment as string).toLowerCase(),
      leafIndex: (p.index as ethers.BigNumber).toNumber(),
      encryptedOutput: (p.encryptedOutput as string).toLowerCase(),
      blockNumber: log.blockNumber,
      txHash: log.transactionHash.toLowerCase(),
      logIndex: log.logIndex,
    }
  }
  if (topic0 === NEW_NULLIFIER_TOPIC.toLowerCase()) {
    const p = iface.decodeEventLog('NewNullifier', log.data, log.topics)
    return {
      kind: 'nullifier',
      nullifier: (p.nullifier as string).toLowerCase(),
      blockNumber: log.blockNumber,
      txHash: log.transactionHash.toLowerCase(),
      logIndex: log.logIndex,
    }
  }
  return null
}
