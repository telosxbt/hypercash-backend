// Entrypoint: migrate DB, start the indexer loops, serve the HTTP API.
import { config } from './config'
import { migrate } from './db'
import { startIndexer } from './indexer'
import { app } from './api'
import { mountRelay } from './relay/mount'

await migrate()
console.log('DB migrated.')

startIndexer()

// Optional relayer (/relay/*) — enabled only when RELAYER_PRIVATE_KEY + addresses are set.
mountRelay(app)

console.log(`HTTP API listening on :${config.port}`)

export default {
  port: config.port,
  fetch: app.fetch,
}
