import { test, expect } from 'bun:test'
import { BigNumber } from 'ethers'
import { checkFee } from './validate'

const RELAYER = '0xAbC0000000000000000000000000000000000001'

test('accepts fee >= min to the relayer', () => {
  const r = checkFee({ feeRecipient: RELAYER.toLowerCase(), fee: '1000' }, RELAYER, BigNumber.from(1000))
  expect(r.ok).toBe(true)
})

test('rejects fee below minimum', () => {
  const r = checkFee({ feeRecipient: RELAYER, fee: '999' }, RELAYER, BigNumber.from(1000))
  expect(r.ok).toBe(false)
  expect(r.error).toContain('below minimum')
})

test('rejects wrong feeRecipient', () => {
  const r = checkFee({ feeRecipient: '0xdead000000000000000000000000000000000000', fee: '5000' }, RELAYER, BigNumber.from(1000))
  expect(r.ok).toBe(false)
  expect(r.error).toContain('feeRecipient')
})

test('feeRecipient match is case-insensitive', () => {
  const r = checkFee({ feeRecipient: RELAYER.toUpperCase(), fee: '1' }, RELAYER, BigNumber.from(0))
  expect(r.ok).toBe(true)
})

test('rejects missing extData', () => {
  expect(checkFee(undefined, RELAYER, BigNumber.from(0)).ok).toBe(false)
})

test('handles hex fee values', () => {
  const r = checkFee({ feeRecipient: RELAYER, fee: '0x2710' /* 10000 */ }, RELAYER, BigNumber.from(10000))
  expect(r.ok).toBe(true)
})

test('rejects invalid fee', () => {
  const r = checkFee({ feeRecipient: RELAYER, fee: 'not-a-number' }, RELAYER, BigNumber.from(0))
  expect(r.ok).toBe(false)
  expect(r.error).toContain('invalid fee')
})
