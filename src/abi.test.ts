import { test, expect } from 'bun:test'
import { ethers } from 'ethers'
import {
  decodeLog,
  iface,
  NEW_COMMITMENT_TOPIC,
  NEW_NULLIFIER_TOPIC,
  EXPECTED_NEW_COMMITMENT_TOPIC,
  type RawLog,
} from './abi'

test('NewCommitment topic matches the spec-pinned value', () => {
  expect(NEW_COMMITMENT_TOPIC.toLowerCase()).toBe(EXPECTED_NEW_COMMITMENT_TOPIC)
})

test('decodes a NewCommitment log round-trip', () => {
  const commitment = '0x' + '11'.repeat(32)
  const index = 42
  const encryptedOutput = '0xdeadbeef'
  const { data, topics } = iface.encodeEventLog(iface.getEvent('NewCommitment'), [
    commitment,
    index,
    encryptedOutput,
  ])
  const log: RawLog = {
    data,
    topics,
    blockNumber: 100,
    transactionHash: '0x' + 'ab'.repeat(32),
    logIndex: 3,
  }
  const dec = decodeLog(log)
  expect(dec?.kind).toBe('commitment')
  if (dec?.kind === 'commitment') {
    expect(dec.commitment).toBe(commitment)
    expect(dec.leafIndex).toBe(42)
    expect(dec.encryptedOutput).toBe('0xdeadbeef')
    expect(dec.blockNumber).toBe(100)
    expect(dec.logIndex).toBe(3)
  }
})

test('decodes a NewNullifier log', () => {
  const nullifier = '0x' + '22'.repeat(32)
  const { data, topics } = iface.encodeEventLog(iface.getEvent('NewNullifier'), [nullifier])
  const dec = decodeLog({
    data,
    topics,
    blockNumber: 7,
    transactionHash: '0x' + 'cd'.repeat(32),
    logIndex: 0,
  })
  expect(dec?.kind).toBe('nullifier')
  if (dec?.kind === 'nullifier') expect(dec.nullifier).toBe(nullifier)
})

test('ignores unrelated logs', () => {
  const dec = decodeLog({
    data: '0x',
    topics: [ethers.utils.id('Transfer(address,address,uint256)')],
    blockNumber: 1,
    transactionHash: '0x' + '00'.repeat(32),
    logIndex: 0,
  })
  expect(dec).toBeNull()
})

test('both topics are distinct', () => {
  expect(NEW_COMMITMENT_TOPIC).not.toBe(NEW_NULLIFIER_TOPIC)
})
