// Entrypoint: migrate DB, start the indexer loops, serve the HTTP API.
import { config } from './config'
import { migrate } from './db'
import { startIndexer } from './indexer'
import { app } from './api'

await migrate()
console.log('DB migrated.')

startIndexer()

console.log(`HTTP API listening on :${config.port}`)

export default {
  port: config.port,
  fetch: app.fetch,
}
