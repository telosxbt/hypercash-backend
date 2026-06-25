import { test, expect } from 'bun:test'
import { BigNumber } from 'ethers'
import { buildTradeParams, isHumanOrder, COIN_MAP } from './order'

const REC = '0x6931c78E0C1D8f701EDca07095C91ee2ef33cAd3'
const CLOID = BigNumber.from(123)

test('isHumanOrder detects the human payload', () => {
  expect(isHumanOrder({ coin: 'ETH' })).toBe(true)
  expect(isHumanOrder({ asset: 11137 })).toBe(false)
  expect(isHumanOrder(null)).toBe(false)
})

test('ETH order → on-chain TradeParams (the case that crashed)', () => {
  const p = buildTradeParams(
    { coin: 'ETH', recipient: REC, size: '0.0062', limitPx: '1630', venue: 1, deadline: '0' },
    CLOID,
  )
  expect(p.asset).toBe(11137)
  expect(p.assetCoreToken).toBe(1242)
  expect(p.size.toString()).toBe('62') // 0.0062 * 1e4
  expect(p.limitPx.toString()).toBe('16300000') // 1630 * 1e(8-4)
  expect(p.recipient).toBe(REC)
  expect(p.venue).toBe(1)
  expect(p.deadline.toString()).toBe('0')
  expect(p.cloid.toString()).toBe('123')
})

test('BTC + HYPE map to the right asset ids', () => {
  expect(COIN_MAP.BTC.asset).toBe(11054)
  expect(COIN_MAP.HYPE.asset).toBe(11035)
  const b = buildTradeParams({ coin: 'btc', recipient: REC, size: '0.1', limitPx: '60000' }, CLOID)
  expect(b.assetCoreToken).toBe(1129)
  expect(b.size.toString()).toBe('10000') // 0.1 * 1e5
})

test('rejects unknown coin', () => {
  expect(() => buildTradeParams({ coin: 'DOGE', recipient: REC, size: '1', limitPx: '1' }, CLOID)).toThrow(
    /unknown coin/,
  )
})

test('rejects invalid recipient', () => {
  expect(() => buildTradeParams({ coin: 'ETH', recipient: '0xnope', size: '1', limitPx: '1' }, CLOID)).toThrow(
    /recipient/,
  )
})
