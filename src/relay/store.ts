// Persistent record of trades the relayer must deliver. Restart-safe: on reboot
// the worker resumes polling the still-open rows. Idempotent via PK + status.
import { sql } from '../db'

export interface RelayTradeRow {
  trader: string
  tradeId: string
  account: string
  assetCoreToken: number
  size: string // uint64 as string
  recipient: string
  txHash: string
}

const DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS relay_trades (
  trader            TEXT   NOT NULL,
  trade_id          BIGINT NOT NULL,
  account           TEXT   NOT NULL,
  asset_core_token  BIGINT NOT NULL,
  size              NUMERIC NOT NULL,
  recipient         TEXT   NOT NULL,
  tx_hash           TEXT   NOT NULL,
  status            TEXT   NOT NULL DEFAULT 'open',  -- 'open' | 'delivered'
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at      TIMESTAMPTZ,
  PRIMARY KEY (trader, trade_id)
);
CREATE INDEX IF NOT EXISTS relay_trades_open ON relay_trades (trader, status);
`

export async function initRelayStore(): Promise<void> {
  await sql.unsafe(DDL)
}

export async function recordTrade(r: RelayTradeRow): Promise<void> {
  await sql`
    INSERT INTO relay_trades (trader, trade_id, account, asset_core_token, size, recipient, tx_hash)
    VALUES (${r.trader}, ${r.tradeId}, ${r.account}, ${r.assetCoreToken}, ${r.size}, ${r.recipient}, ${r.txHash})
    ON CONFLICT (trader, trade_id) DO NOTHING`
}

export async function openTrades(trader: string) {
  return sql<
    { trade_id: string; account: string; asset_core_token: string; size: string }[]
  >`SELECT trade_id, account, asset_core_token, size
    FROM relay_trades WHERE trader = ${trader} AND status = 'open'
    ORDER BY trade_id ASC`
}

export async function markDelivered(trader: string, tradeId: string): Promise<void> {
  await sql`
    UPDATE relay_trades SET status = 'delivered', delivered_at = now()
    WHERE trader = ${trader} AND trade_id = ${tradeId}`
}
