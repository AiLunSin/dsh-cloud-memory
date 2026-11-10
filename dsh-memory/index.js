/**
 * dsh-memory — a persistent, hybrid (semantic + keyword) memory service for
 * DeepSeek Harness sessions, with a three-tier cache and a Web management page.
 *
 * The implementation follows dsh记忆插件技术方案.md, adapted to run in-process:
 * the FastAPI service becomes a Host plugin, PostgreSQL/pgvector becomes the
 * Harness storage KV plus in-memory BM25 and cosine indexes, and Redis remains
 * an optional L3 shared cache.
 */
import { CacheStore } from './lib/cache.js'
import { EmbeddingProvider } from './lib/embedding.js'
import { createNodeHandler, API_PREFIX } from './lib/http.js'
import { MemoryService } from './lib/service.js'
import { MemoryStore } from './lib/store.js'
import { createTools } from './lib/tools.js'
import { asBool, asFloat, asInt } from './lib/util.js'

export const inject = ['storage', 'storage.backend.json', 'tools']

const DEFAULT_PROMPT = [
  '## Persistent memory',
  'You have a persistent memory service for this user, shared across sessions.',
  '- Call memory_search before answering questions that depend on earlier sessions, stable preferences, project decisions, or facts the user expects you to remember.',
  '- Call memory_write when the user states a durable preference, decision, constraint, or profile detail. Keep entries concise and self-contained.',
  '- Call memory_manage to list, inspect, correct, or delete memories, or to read cache statistics.',
  'Never store passwords, API keys, or other secrets. Common phone numbers, emails, IDs, and credentials are masked before storage, but do not rely on that masking as permission to store secrets.',
].join('\n')

function objectOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function resolveConfig(raw) {
  const input = objectOf(raw)
  const embeddingInput = objectOf(input.embedding)
  const retrievalInput = objectOf(input.retrieval)
  const cacheInput = objectOf(input.cache ?? input.caching)
  const securityInput = objectOf(input.security)
  const promptInput = objectOf(input.prompt)
  const provider = ['auto', 'local', 'tei', 'openai'].includes(embeddingInput.provider)
    ? embeddingInput.provider
    : 'auto'
  const userId = typeof input.userId === 'string' && input.userId.trim() && input.userId.length <= 64
    ? input.userId.trim()
    : 'local'
  const l3Url = typeof cacheInput.l3Url === 'string' && cacheInput.l3Url.trim() ? cacheInput.l3Url.trim() : ''
  return {
    userId,
    embedding: {
      provider,
      api: embeddingInput.api === 'openai' ? 'openai' : 'tei',
      baseUrl: typeof embeddingInput.baseUrl === 'string' ? embeddingInput.baseUrl.trim().replace(/\/+$/, '') : '',
      model: typeof embeddingInput.model === 'string' && embeddingInput.model.trim() ? embeddingInput.model.trim() : 'BAAI/bge-m3',
      dim: asInt(embeddingInput.dim, 1024, 64, 4096),
      timeoutMs: asInt(embeddingInput.timeoutMs, 4000, 200, 60000),
      apiKeyEnv: typeof embeddingInput.apiKeyEnv === 'string' && embeddingInput.apiKeyEnv ? embeddingInput.apiKeyEnv : 'BGE_M3_API_KEY',
      fallbackToLocal: asBool(embeddingInput.fallbackToLocal, true),
      ttlEmbedding: asInt(embeddingInput.ttlEmbedding, 604800, 60, 31536000),
    },
    retrieval: {
      rrfK: asInt(retrievalInput.rrfK, 60, 1, 1000),
      wSemantic: asFloat(retrievalInput.wSemantic, 0.6, 0, 10),
      wKeyword: asFloat(retrievalInput.wKeyword, 0.4, 0, 10),
      candidateMultiplier: asInt(retrievalInput.candidateMultiplier, 3, 1, 10),
      channelTimeoutMs: asInt(retrievalInput.channelTimeoutMs, 700, 100, 10000),
      defaultTopK: asInt(retrievalInput.defaultTopK, 8, 1, 50),
    },
    cache: {
      ttlSearch: asInt(cacheInput.ttlSearch, 300, 1, 86400),
      ttlEmbedding: asInt(cacheInput.ttlEmbedding ?? embeddingInput.ttlEmbedding, 604800, 60, 31536000),
      ttlNegative: asInt(cacheInput.ttlNegative, 30, 1, 3600),
      ttlJitterRatio: asFloat(cacheInput.ttlJitterRatio, 0.1, 0, 0.5),
      l1MaxEntries: asInt(cacheInput.l1MaxEntries, 2000, 0, 100000),
      l2MaxEntries: asInt(cacheInput.l2MaxEntries, 20000, 0, 1000000),
      l2MaxBytes: asInt(cacheInput.l2MaxBytes, 64 * 1024 * 1024, 0, 2 * 1024 * 1024 * 1024),
      l2Path: typeof cacheInput.l2Path === 'string' ? cacheInput.l2Path : '',
      l3Url,
      singleflightTimeoutMs: asInt(cacheInput.singleflightTimeoutMs, 250, 10, 5000),
    },
    security: {
      piiMask: asBool(securityInput.piiMask, true),
      allowHardDelete: asBool(securityInput.allowHardDelete, false),
    },
    prompt: {
      enabled: asBool(promptInput.enabled, true),
      text: typeof promptInput.text === 'string' && promptInput.text.trim() ? promptInput.text : DEFAULT_PROMPT,
    },
  }
}

export async function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const logger = ctx.logger
  const store = new MemoryStore({ storage: ctx.storage, logger })
  let cache
  try {
    await store.open()
    cache = new CacheStore({ config: config.cache, logger })
    await cache.open()
  } catch (error) {
    try {
      await store.close()
    } catch {}
    throw error
  }
  const embedder = new EmbeddingProvider({ config: config.embedding, cache, logger })
  const service = new MemoryService({ store, cache, embedder, config, logger })
  service.logger = logger

  ctx.effect(() => () => store.close())
  ctx.effect(() => () => cache.close())

  for (const tool of createTools(service)) {
    ctx.effect(() => ctx.tools.register(tool))
  }

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt && config.prompt.enabled) {
    ctx.effect(() => systemPrompt.section({
      name: 'memory',
      order: 70,
      text: config.prompt.text,
    }))
  }

  const webServer = ctx.get('webServer')
  if (webServer) {
    const handler = createNodeHandler(service)
    ctx.effect(() => webServer.register({ kind: 'prefix', path: API_PREFIX, handler }))
  }

  const sweep = () => {
    service.sweep().catch((error) => {
      logger?.warn?.(`[memory] sweep failed: ${error.message}`)
    })
  }
  const timer = ctx.get('timer')
  if (timer && typeof timer.interval === 'function') {
    ctx.effect(() => timer.interval(sweep, 60 * 60 * 1000))
  } else {
    ctx.effect(() => {
      const handle = setInterval(sweep, 60 * 60 * 1000)
      if (typeof handle?.unref === 'function') handle.unref()
      return () => clearInterval(handle)
    })
  }

  logger?.info?.(`[memory] ready: user=${config.userId} embedding=${embedder.mode} dim=${config.embedding.dim} memory=${store.records.size} cache=l1+l2${config.cache.l3Url ? '+l3' : ''}`)
}
