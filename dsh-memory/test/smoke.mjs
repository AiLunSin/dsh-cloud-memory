import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CacheStore } from '../lib/cache.js'
import { EmbeddingProvider } from '../lib/embedding.js'
import { MemoryService } from '../lib/service.js'
import { MemoryStore } from '../lib/store.js'

const root = path.dirname(fileURLToPath(import.meta.url))
const l2Path = path.join(root, '.smoke-l2.json')

function fakeStorage() {
  const tables = {}
  const unit = {
    async loadAll() {
      return { tables: structuredClone(tables), global: null }
    },
    async putRecord(table, key, value) {
      tables[table] ??= {}
      tables[table][key] = structuredClone(value)
    },
    async deleteRecord(table, key) {
      if (tables[table]) delete tables[table][key]
    },
    async deleteRecords(table, keys) {
      for (const key of keys) if (tables[table]) delete tables[table][key]
    },
    async setGlobal() {},
    async close() {},
  }
  const backend = { kv: { async open() { return unit } }, async close() {} }
  return {
    storage: {
      backend: {
        get(name) {
          if (name !== 'memory') throw new Error('unknown backend')
          return backend
        },
        names() {
          return ['memory']
        },
      },
    },
    tables,
  }
}

const cacheConfig = {
  ttlSearch: 300,
  ttlEmbedding: 604800,
  ttlNegative: 30,
  ttlJitterRatio: 0.1,
  l1MaxEntries: 100,
  l2MaxEntries: 1000,
  l2MaxBytes: 8 * 1024 * 1024,
  l2Path,
  l3Url: '',
  singleflightTimeoutMs: 250,
}

const config = {
  userId: 'local',
  embedding: {
    provider: 'local',
    api: 'tei',
    baseUrl: '',
    model: 'BAAI/bge-m3',
    dim: 1024,
    timeoutMs: 4000,
    apiKeyEnv: 'BGE_M3_API_KEY',
    fallbackToLocal: true,
    ttlEmbedding: 604800,
  },
  retrieval: {
    rrfK: 60,
    wSemantic: 0.6,
    wKeyword: 0.4,
    candidateMultiplier: 3,
    channelTimeoutMs: 1000,
    defaultTopK: 8,
  },
  cache: cacheConfig,
  security: { piiMask: true, allowHardDelete: true },
  prompt: { enabled: false, text: '' },
}

const logger = {
  info() {},
  warn(...args) { console.warn('[warn]', ...args) },
  error(...args) { console.error('[error]', ...args) },
}

async function main() {
  await fs.rm(l2Path, { force: true })
  const fake = fakeStorage()
  const store = new MemoryStore({ storage: fake.storage, logger })
  await store.open()
  const cache = new CacheStore({ config: cacheConfig, logger })
  await cache.open()
  const embedder = new EmbeddingProvider({ config: config.embedding, cache, logger })
  const service = new MemoryService({ store, cache, embedder, config, logger })
  service.logger = logger

  const first = await service.write({
    content: '用户偏好 Python 3.11，使用 FastAPI 构建服务，部署在 K8s。联系方式 test@example.com，手机 13800138000。',
    session_id: 's1',
    keywords: ['Python'],
  })
  console.log('write', first)
  if (!first.id) throw new Error('write failed')

  const fetched = await service.get(first.id)
  console.log('masked content:', fetched.content)
  if (fetched.content.includes('test@example.com') || fetched.content.includes('13800138000')) {
    throw new Error('PII was not masked')
  }
  if (!fetched.keywords.includes('fastapi') && !fetched.keywords.includes('FastAPI')) {
    console.log('keywords:', fetched.keywords)
  }

  const duplicate = await service.write({
    content: '用户偏好 Python 3.11，使用 FastAPI 构建服务，部署在 K8s。联系方式 test@example.com，手机 13800138000。',
    session_id: 's1',
  })
  console.log('duplicate', duplicate)
  if (!duplicate.deduplicated) throw new Error('dedup failed')

  const second = await service.write({
    content: '用户喜欢用 Go 写 CLI 工具，偏好简洁的 cobra 命令行框架。',
    session_id: 's2',
    source: 'chat',
  })
  console.log('write2', second)

  const search1 = await service.search({ query: 'FastAPI 服务', topk: 5, scope: 'user' })
  console.log('search1', JSON.stringify(search1, null, 2))
  if (!search1.results.length) throw new Error('search returned no results')
  if (search1.cache.hit) throw new Error('first search should miss')

  const search2 = await service.search({ query: 'FastAPI 服务', topk: 5, scope: 'user' })
  console.log('search2 cache', search2.cache)
  if (!search2.cache.hit) throw new Error('second search should hit cache')

  const stats = await service.stats({ window: '300s' })
  console.log('stats', JSON.stringify(stats, null, 2))
  if (stats.cache.totals.hits.l1 < 1) throw new Error('l1 hit not counted')

  // Vectors from another embedding model must never participate in cosine
  // scoring against the query model.
  const firstRecord = store.records.get(first.id)
  await store.updateRecord({ ...firstRecord, embedSource: 'different-model' })
  const mismatched = await service.search({ query: 'FastAPI 服务', topk: 5, scope: 'user', use_cache: false })
  const mismatchedRow = mismatched.results.find((item) => item.id === first.id)
  console.log('source mismatch row', mismatchedRow?.sources, mismatchedRow?.scores)
  if (mismatchedRow && mismatchedRow.scores.semantic !== null) {
    throw new Error('cross-model vectors were compared')
  }

  const updated = await service.update(first.id, {
    content: '用户偏好 Python 3.12，使用 FastAPI 构建服务，部署在 K8s。',
    version: first.version,
  })
  console.log('update', updated.id, updated.version, updated.index_version)
  if (updated.version !== 2) throw new Error('version did not increment')

  const afterUpdate = await service.search({ query: 'Python 3.12', topk: 5, scope: 'user' })
  console.log('after update search', afterUpdate.results.map((item) => item.content))
  if (!afterUpdate.results.some((item) => item.content.includes('3.12'))) throw new Error('updated content not searchable')

  const batch = await service.batchWrite({
    items: [
      { content: '用户的项目代号是极光，目标是降低检索延迟。', session_id: 's3' },
      { content: '用户的项目代号是极光，目标是降低检索延迟。', session_id: 's3' },
      { content: '用户每周五做一次复盘。', session_id: 's3' },
    ],
  })
  console.log('batch', batch)
  if (batch.total !== 3 || batch.succeeded !== 3) throw new Error('batch failed')

  const list = await service.list({ limit: 2 })
  console.log('list page1', list.items.length, list.next_cursor, list.total)
  const list2 = await service.list({ limit: 2, cursor: list.next_cursor })
  console.log('list page2', list2.items.length, list2.next_cursor)

  const removed = await service.remove(first.id)
  console.log('remove', removed)
  const afterDelete = await service.search({ query: 'FastAPI', topk: 5, scope: 'user' })
  console.log('after delete search', afterDelete.results.length)
  if (afterDelete.results.some((item) => item.id === first.id)) throw new Error('deleted memory still searchable')

  const reembed = await service.reembed({})
  console.log('reembed', reembed)

  const forcedReembed = await service.reembed({ force: true })
  console.log('force reembed', forcedReembed)
  if (forcedReembed.scanned < 1 || forcedReembed.succeeded !== forcedReembed.scanned) {
    throw new Error('force reembed did not re-embed active memories')
  }

  await cache.close()
  await store.close()
  await fs.rm(l2Path, { force: true })
  console.log('SMOKE OK')
}

main().catch(async (error) => {
  console.error(error)
  await fs.rm(l2Path, { force: true }).catch(() => {})
  process.exitCode = 1
})
