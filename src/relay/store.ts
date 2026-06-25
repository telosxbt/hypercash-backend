// Persistent list of trades the relayer must finish (deliver or cancel).
// Restart-safe: on reboot the worker resumes polling 'open' rows and reads the
// authoritative state (status/deadline/size/account) from trades(id) on-chain.
import { sql } from '../db'

const DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS relay_trades (
  trader      TEXT   NOT NULL,
  trade_id    BIGINT NOT NULL,
  tx_hash     TEXT   NOT NULL,
  status      TEXT   NOT NULL DEFAULT 'open',  -- 'open' | 'done'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at     TIMESTAMPTZ,
  PRIMARY KEY (trader, trade_id)
);
CREATE INDEX IF NOT EXISTS relay_trades_open ON relay_trades (trader, status);
`

export async function initRelayStore(): Promise<void> {
  await sql.unsafe(DDL)
}

export async function recordTrade(trader: string, tradeId: string, txHash: string): Promise<void> {
  await sql`
    INSERT INTO relay_trades (trader, trade_id, tx_hash) VALUES (${trader}, ${tradeId}, ${txHash})
    ON CONFLICT (trader, trade_id) DO NOTHING`
}

export async function openTradeIds(trader: string): Promise<string[]> {
  const rows = await sql<{ trade_id: string }[]>`
    SELECT trade_id FROM relay_trades WHERE trader = ${trader} AND status = 'open'
    ORDER BY trade_id ASC`
  return rows.map((r) => r.trade_id)
}

export async function markDone(trader: string, tradeId: string): Promise<void> {
  await sql`
    UPDATE relay_trades SET status = 'done', done_at = now()
    WHERE trader = ${trader} AND trade_id = ${tradeId}`
}
