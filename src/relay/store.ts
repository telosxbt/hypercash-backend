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

-- Journal for /relay/withdrawToCore so a job that dies mid-flight (after the
-- unshield landed funds at the bridge wallet) can be resumed and delivered to
-- the recorded destination — the user never has to recover funds manually.
CREATE TABLE IF NOT EXISTS spot_withdraws (
  id           BIGSERIAL PRIMARY KEY,
  bridge       TEXT   NOT NULL,           -- the HL_SPOT_BRIDGE wallet
  pool         TEXT   NOT NULL,
  token        TEXT   NOT NULL,           -- underlying ERC20
  core_token   BIGINT NOT NULL,
  destination  TEXT   NOT NULL,
  evm_received TEXT   NOT NULL,           -- amount unshielded to the bridge (wei)
  core_before  TEXT   NOT NULL,           -- bridge Core spot balance before bridging
  withdraw_tx  TEXT,
  bridge_tx    TEXT,
  spotsend_tx  TEXT,
  status       TEXT   NOT NULL DEFAULT 'unshielded',  -- unshielded|bridged|done
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS spot_withdraws_open ON spot_withdraws (bridge, status);
`

export interface SpotWithdraw {
  id: string
  bridge: string
  pool: string
  token: string
  core_token: string
  destination: string
  evm_received: string
  core_before: string
  withdraw_tx: string | null
  bridge_tx: string | null
  spotsend_tx: string | null
  status: 'unshielded' | 'bridged' | 'done'
}

export async function createSpotWithdraw(row: {
  bridge: string
  pool: string
  token: string
  coreToken: string
  destination: string
  evmReceived: string
  coreBefore: string
  withdrawTx: string
}): Promise<string> {
  const [r] = await sql<{ id: string }[]>`
    INSERT INTO spot_withdraws (bridge, pool, token, core_token, destination, evm_received, core_before, withdraw_tx)
    VALUES (${row.bridge}, ${row.pool}, ${row.token}, ${row.coreToken}, ${row.destination},
            ${row.evmReceived}, ${row.coreBefore}, ${row.withdrawTx})
    RETURNING id`
  return r.id
}

export async function setSpotBridged(id: string, bridgeTx: string): Promise<void> {
  await sql`UPDATE spot_withdraws SET status='bridged', bridge_tx=${bridgeTx}, updated_at=now() WHERE id=${id}`
}

export async function setSpotDone(id: string, spotSendTx: string): Promise<void> {
  await sql`UPDATE spot_withdraws SET status='done', spotsend_tx=${spotSendTx}, updated_at=now() WHERE id=${id}`
}

// Open (unfinished) jobs for a bridge wallet, oldest first — the resume worker
// finishes these in order so the per-job Core delta stays clean.
export async function openSpotWithdraws(bridge: string): Promise<SpotWithdraw[]> {
  return sql<SpotWithdraw[]>`
    SELECT * FROM spot_withdraws WHERE bridge=${bridge} AND status <> 'done'
    ORDER BY id ASC`
}

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
