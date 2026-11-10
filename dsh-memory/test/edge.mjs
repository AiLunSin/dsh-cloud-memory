import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CacheStore } from '../lib/cache.js'
import { EmbeddingProvider } from '../lib/embedding.js'
import { MemoryService, ApiError } from '../lib/service.js'
import { MemoryStore } from '../lib/store.js'

const root = path.dirname(fileURLToPath(import.meta.url))
const l2Path = path.join(root, '.edge-l2.json')

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
    provider: 'tei', api: 'tei', baseUrl: 'http://127.0.0.1:59999', model: 'BAAI/bge-m3', dim: 1024,
    timeoutMs: 200, apiKeyEnv: 'BGE_M3_API_KEY', fallbackToLocal: true, ttlEmbedding: 604800,
  },
  retrieval: { rrfK: 60, wSemantic: 0.6, wKeyword: 0.4, candidateMultiplier: 3, channelTimeoutMs: 1000, defaultTopK: 8 },
  cache: cacheConfig,
  security: { piiMask: true, allowHardDelete: false },
  prompt: { enabled: false, text: '' },
}
const logger = { info() {}, warn() {}, error() {} }

function expectError(fn, status, code) {
  return fn().then(
    () => { throw new Error(`expected error ${code}`) },
    (error) => {
      if (!(error instanceof ApiError)) throw error
      if (error.status !== status || error.code !== code) {
        throw new Error(`expected ${status}/${code}, got ${error.status}/${error.code}: ${error.message}`)
      }
    },
  )
}

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

  const first = await service.write({ content: '用户偏好 Rust 与 tokio，用于高并发服务。', session_id: 's1' })
  console.log('fallback write', first.embed_status, first.embed_source, first.warning)
  if (first.embed_status !== 'ok' || first.embed_source !== 'local') throw new Error('remote fallback did not produce local vector')

  const search = await service.search({ query: 'Rust', scope: 'user' })
  console.log('degraded search', search.degraded, search.degraded_reason)
  if (!search.degraded) throw new Error('remote failure not marked degraded')

  const before = store.count('local').active
  await expectError(
    () => service.batchWrite({
      atomic: true,
      items: [
        { content: '合法条目', session_id: 's3' },
        { content: 'x'.repeat(9000), session_id: 's3' },
      ],
    }),
    409,
    40903,
  )
  const after = store.count('local').active
  console.log('atomic rollback count', before, after)
  if (before !== after) throw new Error('atomic batch wrote records')

  const s1 = await service.write({ content: '会话一：用户使用 Redis 做缓存。', session_id: 's1', source: 'chat' })
  const s2 = await service.write({ content: '会话二：用户使用 Postgres 存数据。', session_id: 's2', source: 'note' })
  const filtered = await service.search({
    query: 'Redis Postgres',
    scope: 'user',
    filters: { session_ids: ['s2'] },
  })
  console.log('session filter', filtered.results.map((item) => item.session_id))
  if (filtered.results.some((item) => item.session_id !== 's2')) throw new Error('session filter failed')

  const scoped = await service.search({ query: 'Redis', scope: 'session', session_id: 's2' })
  console.log('scope session s2', scoped.results.map((item) => item.content))
  if (scoped.results.some((item) => item.session_id !== 's2')) throw new Error('scope filter failed')

  await expectError(
    () => service.search({ query: 'Redis', scope: 'session' }),
    400,
    40001,
  )

  const strict = await service.search({ query: 'Rust', min_score: 0.99, scope: 'user' })
  console.log('min_score strict', strict.results.length, strict.results.map((item) => item.scores.semantic))
  if (strict.results.some((item) => item.scores.semantic !== null && item.scores.semantic < 0.99)) {
    throw new Error('min_score did not filter semantic results')
  }

  const boolean = await service.search({ query: '"Redis 做缓存" OR Postgres', scope: 'user' })
  console.log('boolean search', boolean.results.length)

  await expectError(() => service.update(s1.id, { content: 'changed', version: 99 }), 409, 40901)

  await expectError(() => service.remove(s1.id, { hard: true }), 403, 40302)

  const deleted = await service.remove(s1.id)
  console.log('soft delete', deleted.deleted)
  const count = store.count('local')
  console.log('counts', count)
  if (count.deleted < 1) throw new Error('deleted count missing')

  await cache.close()
  await store.close()
  await fs.rm(l2Path, { force: true })
  console.log('EDGE OK')
}

main().catch(async (error) => {
  console.error(error)
  await fs.rm(l2Path, { force: true }).catch(() => {})
  process.exitCode = 1
})
