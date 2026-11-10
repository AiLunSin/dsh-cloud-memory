/** Embedding access: BGE-M3 over a TEI/OpenAI-compatible endpoint, with a deterministic local fallback. */
import { l2Normalize, localEmbed, sha256 } from './util.js'

const LOCAL_MODEL_ID = 'local-hash-v1'

export class EmbeddingProvider {
  constructor(options) {
    this.config = options.config
    this.cache = options.cache
    this.logger = options.logger
    this.dim = this.config.dim
    this.model = this.config.model
    this.transport = this.config.provider === 'auto'
      ? (this.config.baseUrl ? (this.config.api === 'openai' ? 'openai' : 'tei') : 'local')
      : this.config.provider
    this.mode = this.transport === 'local' ? 'local' : (this.transport === 'openai' ? 'openai' : 'tei')
    this.modelId = this.mode === 'local' ? LOCAL_MODEL_ID : `${this.mode}:${this.model}`
    this.status = {
      mode: this.mode,
      model: this.mode === 'local' ? LOCAL_MODEL_ID : this.model,
      dim: this.dim,
      state: this.mode === 'local' ? 'local' : 'unknown',
      last_error: null,
      last_latency_ms: null,
      last_at: null,
      calls: 0,
      failures: 0,
    }
  }

  info() {
    return {
      ...this.status,
      base_url: this.config.baseUrl || null,
      fallback_to_local: this.config.fallbackToLocal,
    }
  }

  embeddingKey(text) {
    return `m:e:${sha256(`${this.modelId}|${text}`)}`
  }

  async lookupCached(text) {
    const key = this.embeddingKey(text)
    const cached = await this.cache.get(key, { stats: false, ttlSeconds: this.config.ttlEmbedding }).catch(() => null)
    if (!cached) return null
    try {
      const parsed = JSON.parse(cached.value)
      if (!Array.isArray(parsed) || parsed.length !== this.dim) return null
      return Float32Array.from(parsed)
    } catch {
      return null
    }
  }

  storeCached(text, vector) {
    const key = this.embeddingKey(text)
    this.cache.set(key, JSON.stringify(Array.from(vector)), this.config.ttlEmbedding)
  }

  /**
   * @param {string[]} texts
   * @returns {Promise<{vectors: (Float32Array|null)[], sources: string[], error: string|null}>}
   */
  async embedMany(texts) {
    const vectors = new Array(texts.length).fill(null)
    // The source names the vector space, not how the value was obtained. A
    // cache hit still belongs to this provider's model, so records written from
    // cache stay comparable with fresh query embeddings.
    const sources = new Array(texts.length).fill(this.mode)
    const pending = []
    for (let index = 0; index < texts.length; index += 1) {
      const cached = await this.lookupCached(texts[index])
      if (cached) {
        vectors[index] = cached
        sources[index] = this.mode
        this.cache.recordEmbedding('cached')
      } else {
        pending.push(index)
      }
    }
    if (!pending.length) return { vectors, sources, error: null }

    let error = null
    if (this.mode === 'local') {
      this.status.calls += 1
      for (const index of pending) {
        const vector = localEmbed(texts[index], this.dim)
        vectors[index] = vector
        sources[index] = 'local'
        this.cache.recordEmbedding('local')
        this.storeCached(texts[index], vector)
      }
      this.noteSuccess(null)
      return { vectors, sources, error: null }
    }

    try {
      const started = performance.now()
      const remoteVectors = new Array(pending.length)
      // TEI / vLLM endpoints usually cap batch size; chunking keeps a 100-item
      // batch write from turning into one oversized embedding request.
      const chunkSize = Math.max(1, Math.min(32, this.config.batchSize || 32))
      for (let start = 0; start < pending.length; start += chunkSize) {
        const slice = pending.slice(start, start + chunkSize)
        this.status.calls += 1
        const chunkVectors = await this.requestRemote(slice.map((index) => texts[index]))
        if (chunkVectors.length !== slice.length) {
          throw new Error('embedding endpoint returned a mismatched batch')
        }
        for (let offset = 0; offset < slice.length; offset += 1) {
          remoteVectors[start + offset] = chunkVectors[offset]
        }
      }
      const latency = performance.now() - started
      for (let offset = 0; offset < pending.length; offset += 1) {
        const index = pending[offset]
        const vector = remoteVectors[offset]
        vectors[index] = vector
        sources[index] = this.mode
        this.cache.recordEmbedding('api')
        this.storeCached(texts[index], vector)
      }
      this.noteSuccess(latency)
    } catch (caught) {
      error = caught?.message || String(caught)
      this.noteFailure(error)
      if (!this.config.fallbackToLocal) {
        return { vectors, sources, error }
      }
      for (const index of pending) {
        if (vectors[index]) continue
        const vector = localEmbed(texts[index], this.dim)
        vectors[index] = vector
        sources[index] = 'local'
        this.cache.recordEmbedding('local')
        this.storeCached(texts[index], vector)
      }
      this.logger?.warn?.(`[memory] embedding endpoint failed, using local fallback: ${error}`)
    }
    return { vectors, sources, error }
  }

  async embedOne(text) {
    const result = await this.embedMany([text])
    return { vector: result.vectors[0], source: result.sources[0], error: result.error }
  }

  noteSuccess(latencyMs) {
    this.status.state = 'ok'
    this.status.last_error = null
    this.status.last_latency_ms = typeof latencyMs === 'number' ? Number(latencyMs.toFixed(1)) : null
    this.status.last_at = new Date().toISOString()
  }

  noteFailure(message) {
    this.status.state = 'degraded'
    this.status.last_error = message
    this.status.last_at = new Date().toISOString()
    this.status.failures += 1
  }

  endpoint() {
    const base = String(this.config.baseUrl || '').replace(/\/+$/, '')
    if (this.mode === 'openai') {
      if (base.endsWith('/v1/embeddings')) return base
      if (base.endsWith('/v1')) return `${base}/embeddings`
      return `${base}/v1/embeddings`
    }
    if (base.endsWith('/embed')) return base
    return `${base}/embed`
  }

  headers() {
    const headers = { 'content-type': 'application/json' }
    const envName = this.config.apiKeyEnv
    if (envName && process.env[envName]) headers.authorization = `Bearer ${process.env[envName]}`
    return headers
  }

  async requestRemote(texts) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs)
    if (typeof timeout?.unref === 'function') timeout.unref()
    const body = this.mode === 'openai'
      ? { model: this.model, input: texts }
      : { inputs: texts, normalize: true }
    let response
    try {
      response = await fetch(this.endpoint(), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`embedding endpoint ${response.status}: ${detail.slice(0, 200)}`)
    }
    const payload = await response.json()
    let raw
    if (Array.isArray(payload)) raw = payload
    else if (Array.isArray(payload?.data)) raw = payload.data.map((item) => item?.embedding)
    else if (Array.isArray(payload?.embeddings)) raw = payload.embeddings
    if (!Array.isArray(raw) || raw.length !== texts.length) {
      throw new Error('embedding endpoint returned an unexpected payload')
    }
    return raw.map((item, index) => {
      if (!Array.isArray(item) || item.length !== this.dim) {
        throw new Error(`embedding dimension mismatch at index ${index}: expected ${this.dim}`)
      }
      return l2Normalize(Float32Array.from(item))
    })
  }
}
