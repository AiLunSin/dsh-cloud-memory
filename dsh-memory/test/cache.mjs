import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CacheStore } from '../lib/cache.js'
import { EmbeddingProvider } from '../lib/embedding.js'
import { MemoryService } from '../lib/service.js'
import { MemoryStore } from '../lib/store.js'

const root = path.dirname(fileURLToPath(import.meta.url))
const l2Path = path.join(root, '.cache-l2.json')
const logger = { info() {}, warn() {}, error() {} }
const cacheConfig = {
  ttlSearch: 300, ttlEmbedding: 604800, ttlNegative: 30, ttlJitterRatio: 0,
  l1MaxEntries: 2, l2MaxEntries: 10, l2MaxBytes: 1024 * 1024,
  l2Path, l3Url: '', singleflightTimeoutMs: 250,
}

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

async function main() {
  await fs.rm(l2Path, { force: true })

  // L2 survives a close/reopen.
  const cacheA = new CacheStore({ config: cacheConfig, logger })
  await cacheA.open()
  cacheA.set('m:s:test', JSON.stringify({ hello: 'world' }), 300)
  await cacheA.close()
  const raw = await fs.readFile(l2Path, 'utf8')
  console.log('l2 file bytes', raw.length)
  if (!raw.includes('m:s:test')) throw new Error('L2 file did not persist the key')
  const cacheB = new CacheStore({ config: cacheConfig, logger })
  await cacheB.open()
  const hit = await cacheB.get('m:s:test')
  console.log('l2 reopen hit', hit?.level, hit?.value)
  if (!hit || hit.level !== 'l2') throw new Error('L2 reopen did not hit')
  cacheB.set('m:e:keep', JSON.stringify({ vector: true }), 60)
  const purged = await cacheB.purge('all', 'all')
  const removedSearch = await cacheB.get('m:s:test', { stats: false })
  const keptEmbedding = await cacheB.get('m:e:keep', { stats: false })
  console.log('l2 purge', purged, 'search', removedSearch?.level ?? null, 'embedding', keptEmbedding?.level ?? null)
  if (removedSearch !== null) throw new Error('purge did not remove the search cache entry')
  if (!keptEmbedding) throw new Error('purge removed the embedding cache entry')
  await cacheB.close()
  await fs.rm(l2Path, { force: true })

  // Concurrent writes each advance the user index version exactly once.
  const fake = fakeStorage()
  const store = new MemoryStore({ storage: { backend: { get: () => fake.backend, names: () => ['memory'] } }, logger })
  await store.open()
  const cache = new CacheStore({ config: cacheConfig, logger })
  await cache.open()
  const embedder = new EmbeddingProvider({ config: config.embedding, cache, logger })
  const service = new MemoryService({ store, cache, embedder, config, logger })
  service.logger = logger
  const start = await service.currentVersion('local')
  const writes = await Promise.all(Array.from({ length: 8 }, (_, index) => service.write({
    content: `并发写入测试条目 ${index} 的唯一内容。`,
    session_id: `s${index}`,
  })))
  const versions = writes.map((item) => item.index_version)
  const end = await service.currentVersion('local')
  console.log('index versions', start, versions, end)
  if (end !== start + 8) throw new Error(`expected ${start + 8} index version, got ${end}`)
  if (new Set(versions).size !== 8) throw new Error('index versions were reused')
  await cache.close()
  await store.close()
  await fs.rm(l2Path, { force: true }).catch(() => {})
  console.log('CACHE OK')
}

main().catch(async (error) => {
  console.error(error)
  await fs.rm(l2Path, { force: true }).catch(() => {})
  process.exitCode = 1
})
