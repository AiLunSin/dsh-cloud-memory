import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CacheStore } from '../lib/cache.js'
import { EmbeddingProvider } from '../lib/embedding.js'
import { createNodeHandler } from '../lib/http.js'
import { MemoryService } from '../lib/service.js'
import { MemoryStore } from '../lib/store.js'

const root = path.dirname(fileURLToPath(import.meta.url))
const l2Path = path.join(root, '.node-http-l2.json')

function fakeStorage() {
  const tables = {}
  const unit = {
    async loadAll() { return { tables: structuredClone(tables), global: null } },
    async putRecord(table, key, value) { tables[table] ??= {}; tables[table][key] = structuredClone(value) },
    async deleteRecord(table, key) { if (tables[table]) delete tables[table][key] },
    async deleteRecords(table, keys) { for (const key of keys) if (tables[table]) delete tables[table][key] },
    async setGlobal() {},
    async close() {},
  }
  const backend = { kv: { async open() { return unit } }, async close() {} }
  return { backend }
}

const cacheConfig = {
  ttlSearch: 300, ttlEmbedding: 604800, ttlNegative: 30, ttlJitterRatio: 0,
  l1MaxEntries: 100, l2MaxEntries: 1000, l2MaxBytes: 8 * 1024 * 1024,
  l2Path, l3Url: '', singleflightTimeoutMs: 250,
}
const config = {
  userId: 'local',
  embedding: {
    provider: 'local', api: 'tei', baseUrl: '', model: 'BAAI/bge-m3', dim: 1024,
    timeoutMs: 1000, apiKeyEnv: 'BGE_M3_API_KEY', fallbackToLocal: true, ttlEmbedding: 604800,
  },
  retrieval: { rrfK: 60, wSemantic: 0.6, wKeyword: 0.4, candidateMultiplier: 3, channelTimeoutMs: 1000, defaultTopK: 8 },
  cache: cacheConfig,
  security: { piiMask: true, allowHardDelete: true },
  prompt: { enabled: false, text: '' },
}
const logger = { info() {}, warn() {}, error() {} }

async function main() {
  await fs.rm(l2Path, { force: true })
  const fake = fakeStorage()
  const store = new MemoryStore({
    storage: { backend: { get: () => fake.backend, names: () => ['memory'] } },
    logger,
  })
  await store.open()
  const cache = new CacheStore({ config: cacheConfig, logger })
  await cache.open()
  const embedder = new EmbeddingProvider({ config: config.embedding, cache, logger })
  const service = new MemoryService({ store, cache, embedder, config, logger })
  service.logger = logger
  const handler = createNodeHandler(service)
  const server = http.createServer((req, res) => { handler(req, res) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}/dsh-memory/api`

  const call = async (pathname, init) => {
    const response = await fetch(`${base}${pathname}`, init)
    return { status: response.status, body: await response.json() }
  }

  const write = await call('/memories', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '用户偏好 FastAPI 与 PostgreSQL。', session_id: 's1' }),
  })
  console.log('node write', write.status, write.body.code, write.body.data?.id)
  if (write.status !== 201) throw new Error('node write failed')

  const search = await call('/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'FastAPI', topk: 5 }),
  })
  console.log('node search', search.status, search.body.data?.total)
  if (!search.body.data?.total) throw new Error('node search failed')

  const stats = await call('/stats?window=300s')
  console.log('node stats', stats.status, stats.body.data?.memories?.active)
  if (stats.status !== 200) throw new Error('node stats failed')

  const remove = await call(`/memories/${write.body.data.id}`, { method: 'DELETE' })
  console.log('node delete', remove.status, remove.body.data?.deleted)
  if (!remove.body.data?.deleted) throw new Error('node delete failed')

  await new Promise((resolve) => server.close(resolve))
  await cache.close()
  await store.close()
  await fs.rm(l2Path, { force: true })
  console.log('NODE HTTP OK')
}

main().catch(async (error) => {
  console.error(error)
  await fs.rm(l2Path, { force: true }).catch(() => {})
  process.exitCode = 1
})
