import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CacheStore } from '../lib/cache.js'
import { EmbeddingProvider } from '../lib/embedding.js'
import { createHttpHandler } from '../lib/http.js'
import { MemoryService } from '../lib/service.js'
import { MemoryStore } from '../lib/store.js'

const root = path.dirname(fileURLToPath(import.meta.url))
const l2Path = path.join(root, '.http-l2.json')

function fakeStorage() {
  const tables = {}
  const unit = {
    async loadAll() { return { tables: structuredClone(tables), global: null } },
    async putRecord(table, key, value) {
      tables[table] ??= {}
      tables[table][key] = structuredClone(value)
    },
    async deleteRecord(table, key) { if (tables[table]) delete tables[table][key] },
    async deleteRecords(table, keys) { for (const key of keys) if (tables[table]) delete tables[table][key] },
    async setGlobal() {},
    async close() {},
  }
  const backend = { kv: { async open() { return unit } }, async close() {} }
  return { backend, tables }
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
  const handler = createHttpHandler(service)

  const call = async (pathname, init) => {
    const response = await handler(new Request(`http://local/dsh-memory/api${pathname}`, init), undefined)
    const body = await response.json()
    return { status: response.status, body }
  }

  const writeBody = { content: '用户偏好 FastAPI，邮箱 dev@example.com。', session_id: 's1' }
  const write1 = await call('/memories', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'k1' },
    body: JSON.stringify(writeBody),
  })
  console.log('write1', write1.status, write1.body.code, write1.body.data?.id)
  if (write1.status !== 201 || write1.body.code !== 0) throw new Error('write failed')

  const write2 = await call('/memories', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'k1' },
    body: JSON.stringify(writeBody),
  })
  console.log('write2 replay', write2.status, write2.body.data?.id)
  if (write2.body.data?.id !== write1.body.data?.id) throw new Error('idempotency replay changed id')

  const conflict = await call('/memories', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'k1' },
    body: JSON.stringify({ ...writeBody, content: 'different' }),
  })
  console.log('idempotency conflict', conflict.status, conflict.body.code)
  if (conflict.status !== 409 || conflict.body.code !== 40902) throw new Error('idempotency conflict not detected')

  const search = await call('/search?q=FastAPI')
  console.log('search', search.status, search.body.data?.results?.length)
  if (!search.body.data?.results?.length) throw new Error('search failed')

  const stats = await call('/stats?window=300s')
  console.log('stats hit rate', stats.body.data?.cache?.hit_rate)
  if (stats.body.data?.cache?.hit_rate?.overall > 1) throw new Error('bad hit rate')

  const batch = await call('/memories:batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ content: '用户每周五复盘。', session_id: 's2' }, { content: '用户喜欢简洁的 CLI。', session_id: 's2' }] }),
  })
  console.log('batch', batch.status, batch.body.data?.succeeded)
  if (batch.status !== 200 || batch.body.data?.succeeded !== 2) throw new Error('batch failed')

  const detail = await call(`/memories/${write1.body.data.id}`)
  console.log('detail masked', detail.body.data?.content)
  if (detail.body.data?.content?.includes('dev@example.com')) throw new Error('detail not masked')

  const removed = await call(`/memories/${write1.body.data.id}?hard=true`, { method: 'DELETE' })
  console.log('hard delete', removed.status, removed.body.data)
  if (!removed.body.data?.hard) throw new Error('hard delete failed')

  const missing = await call(`/memories/${write1.body.data.id}`)
  console.log('missing', missing.status, missing.body.code)
  if (missing.status !== 404) throw new Error('missing did not 404')

  const badJson = await call('/memories', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{bad',
  })
  console.log('bad json', badJson.status, badJson.body.code)
  if (badJson.status !== 400) throw new Error('bad JSON not rejected')

  await cache.close()
  await store.close()
  await fs.rm(l2Path, { force: true })
  console.log('HTTP OK')
}

main().catch(async (error) => {
  console.error(error)
  await fs.rm(l2Path, { force: true }).catch(() => {})
  process.exitCode = 1
})
