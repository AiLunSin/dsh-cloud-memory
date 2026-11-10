/**
 * Semantic retrieval quality benchmark against the real local BGE-M3 endpoint.
 *
 * Start the endpoint first:
 *   cd embedding-service && npm install --ignore-scripts && node server.mjs
 * Then:
 *   npm run test:semantic
 *
 * Override the endpoint with EMBEDDING_URL=http://127.0.0.1:8090.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CacheStore } from '../lib/cache.js'
import { EmbeddingProvider } from '../lib/embedding.js'
import { MemoryService } from '../lib/service.js'
import { MemoryStore } from '../lib/store.js'

const root = path.dirname(fileURLToPath(import.meta.url))
const l2Path = path.join(root, '.semantic-l2.json')
const endpoint = (process.env.EMBEDDING_URL || 'http://127.0.0.1:8090').replace(/\/+$/, '')

const corpus = [
  { label: 'python', content: '用户偏好用 Python 的 FastAPI 框架编写后端接口，服务部署在 Kubernetes 集群。' },
  { label: 'allergy', content: '用户对花生过敏，外出就餐时会避开含坚果的菜品。' },
  { label: 'retro', content: '项目每周五下午做迭代复盘，并产出下周的优先级列表。' },
  { label: 'postgres', content: '生产数据库使用 PostgreSQL 16，备份保留 30 天。' },
  { label: 'ui', content: '用户喜欢简洁的深色界面，字号偏小。' },
  { label: 'travel', content: '用户计划明年去日本京都看樱花。' },
  { label: 'complaints', content: '客户投诉主要集中在配送延迟和包装破损。' },
  { label: 'meeting', content: '团队周一上午十点开周会，同步项目风险。' },
  { label: 'distractor-fastapi', content: 'FastAPI 官方文档更新了路由示例。' },
  { label: 'distractor-peanut', content: '花生酱是常见的调味品。' },
  { label: 'distractor-friday', content: '周五下午的午餐订了披萨。' },
  { label: 'distractor-postgres', content: 'PostgreSQL 的 SQL 语法与其他数据库不同。' },
  { label: 'distractor-dark', content: '深色模式可以减少夜间屏幕眩光。' },
  { label: 'distractor-kyoto', content: '京都的樱花季通常在三月底。' },
  { label: 'distractor-delivery', content: '配送延迟时客户可以申请退款。' },
  { label: 'distractor-meeting', content: '周会纪要需要发到项目群里。' },
]

const queries = [
  { query: '哪些食物可能让用户产生不良反应？', label: 'allergy' },
  { query: '团队什么时候总结本周工作？', label: 'retro' },
  { query: '数据存储和恢复策略是怎样的？', label: 'postgres' },
  { query: '视觉风格上用户有什么喜好？', label: 'ui' },
  { query: '假期旅行目的地是哪里？', label: 'travel' },
  { query: '售后问题有哪些？', label: 'complaints' },
  { query: '例会安排在什么时间？', label: 'meeting' },
  { query: '接口层是用哪套工具开发的？', label: 'python' },
]

const cacheConfig = {
  ttlSearch: 300,
  ttlEmbedding: 604800,
  ttlNegative: 30,
  ttlJitterRatio: 0,
  l1MaxEntries: 200,
  l2MaxEntries: 1000,
  l2MaxBytes: 16 * 1024 * 1024,
  l2Path,
  l3Url: '',
  singleflightTimeoutMs: 250,
}

const config = {
  userId: 'semantic-eval',
  embedding: {
    provider: 'tei',
    api: 'tei',
    baseUrl: endpoint,
    model: 'BAAI/bge-m3',
    dim: 1024,
    timeoutMs: 120000,
    apiKeyEnv: '',
    fallbackToLocal: false,
    ttlEmbedding: 604800,
  },
  retrieval: {
    rrfK: 60,
    wSemantic: 0.6,
    wKeyword: 0.4,
    candidateMultiplier: 3,
    channelTimeoutMs: 120000,
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

async function waitForEndpoint(timeoutMs = 2 * 60 * 1000) {
  const started = Date.now()
  for (;;) {
    try {
      const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(5000) })
      const body = await response.json()
      if (body.ok) return body
      if (body.state === 'failed') throw new Error(`embedding endpoint failed: ${body.error}`)
    } catch (error) {
      if (Date.now() - started > timeoutMs) throw new Error(`embedding endpoint not ready: ${error.message}`)
    }
    if (Date.now() - started > timeoutMs) throw new Error('embedding endpoint did not become ready')
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}

function metrics(rows) {
  const top1 = rows.filter((row) => row.rank === 1).length / rows.length
  const top3 = rows.filter((row) => row.rank <= 3).length / rows.length
  const mrr = rows.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / rows.length
  return { top1, top3, mrr }
}

function formatPct(value) {
  return `${(value * 100).toFixed(0)}%`
}

async function runMode(service, mode, weights, ids) {
  const rows = []
  for (const query of queries) {
    const request = service.normalizeSearchInput({
      query: query.query,
      topk: 5,
      candidate_k: 30,
      scope: 'user',
      w_semantic: weights.semantic,
      w_keyword: weights.keyword,
      use_cache: false,
    })
    const started = performance.now()
    let items
    let latency
    if (mode === 'semantic-only') {
      items = (await service.semanticSearch(request)).items
      latency = Number((performance.now() - started).toFixed(2))
    } else if (mode === 'keyword-only') {
      items = service.keywordSearch(request)
      latency = Number((performance.now() - started).toFixed(2))
    } else {
      const result = await service.search({
        query: query.query,
        topk: 5,
        candidate_k: 30,
        scope: 'user',
        w_semantic: weights.semantic,
        w_keyword: weights.keyword,
        use_cache: false,
      })
      items = result.results
      latency = result.latency_ms
    }
    const rank = items.findIndex((item) => item.id === ids.get(query.label)) + 1
    if (process.env.DEBUG_SEMANTIC === query.label) {
      console.log(`\n[debug ${mode}] ${query.query}`)
      for (const item of items) {
        console.log(`  ${item.id === ids.get(query.label) ? '*' : ' '} ${item.content}  sem=${item.scores?.semantic ?? '—'} kw=${item.scores?.keyword ?? '—'}`)
      }
    }
    rows.push({ query: query.query, label: query.label, rank: rank || 99, total: items.length, latency })
  }
  return { mode, rows, metrics: metrics(rows) }
}

async function main() {
  await fs.rm(l2Path, { force: true })
  const health = await waitForEndpoint()
  console.log(`endpoint: ${endpoint}  model=${health.model}  state=${health.state}  dim=${health.dim}`)

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

  const batch = await service.batchWrite({
    items: corpus.map((item) => ({ content: item.content, session_id: 'semantic-eval', source: 'eval' })),
  })
  if (batch.succeeded !== corpus.length) {
    throw new Error(`corpus write failed: ${JSON.stringify(batch.items.filter((item) => item.status === 'failed'))}`)
  }
  const ids = new Map()
  for (let index = 0; index < corpus.length; index += 1) ids.set(corpus[index].label, batch.items[index].id)
  console.log(`corpus: ${corpus.length} memories, embed=${batch.embed_status}, index_version=${batch.index_version}`)

  const semantic = await runMode(service, 'semantic', { semantic: 1, keyword: 0 }, ids)
  const keyword = await runMode(service, 'keyword', { semantic: 0, keyword: 1 }, ids)
  const hybridDefault = await runMode(service, 'hybrid 0.6/0.4', { semantic: 0.6, keyword: 0.4 }, ids)
  const hybridSemantic = await runMode(service, 'hybrid 0.8/0.2', { semantic: 0.8, keyword: 0.2 }, ids)
  const hybridVerySemantic = await runMode(service, 'hybrid 0.9/0.1', { semantic: 0.9, keyword: 0.1 }, ids)

  const modes = [semantic, keyword, hybridDefault, hybridSemantic, hybridVerySemantic]
  console.log('\nRank of the labeled target (1 = top hit, 99 = not in top 5):')
  const header = ['query'.padEnd(30), ...modes.map((mode) => mode.mode.padStart(16))].join(' ')
  console.log(header)
  for (let index = 0; index < queries.length; index += 1) {
    const cells = modes.map((mode) => String(mode.rows[index].rank).padStart(16))
    console.log(`${queries[index].query.padEnd(30)} ${cells.join(' ')}`)
  }
  console.log('\nMetrics:')
  for (const mode of modes) {
    console.log(`${mode.mode.padEnd(18)} top1=${formatPct(mode.metrics.top1)} top3=${formatPct(mode.metrics.top3)} MRR=${mode.metrics.mrr.toFixed(3)}`)
  }
  console.log('\nSemantic latency (ms):', semantic.rows.map((row) => row.latency).join(', '))

  const failures = semantic.rows.filter((row) => row.rank > 3)
  if (semantic.metrics.top3 < 0.75) {
    throw new Error(`semantic top3 ${formatPct(semantic.metrics.top3)} is below 75% (failed: ${failures.map((row) => row.label).join(', ')})`)
  }
  if (semantic.metrics.mrr < 0.7) {
    throw new Error(`semantic MRR ${semantic.metrics.mrr.toFixed(3)} is below 0.7`)
  }

  await cache.close()
  await store.close()
  await fs.rm(l2Path, { force: true })
  console.log('\nSEMANTIC OK')
}

main().catch(async (error) => {
  console.error(error)
  await fs.rm(l2Path, { force: true }).catch(() => {})
  process.exitCode = 1
})
