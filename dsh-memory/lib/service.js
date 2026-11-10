/** Memory business rules: write pipeline, hybrid retrieval, versioned cache, CRUD. */
import {
  BUILD,
  asBool,
  asFloat,
  asInt,
  clamp,
  decodeVector,
  extractKeywords,
  hashFilters,
  maskPII,
  normalizeQuery,
  normalizeText,
  nowIso,
  parseTime,
  sha1,
  sha256,
  sleep,
  stableStringify,
  uuid,
  cosine,
  l2Normalize,
} from './util.js'

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

function fail(status, code, message) {
  throw new ApiError(status, code, message)
}

function sanitizeKeywords(input) {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) fail(400, 40001, 'keywords must be an array')
  const seen = new Set()
  const result = []
  for (const raw of input) {
    if (typeof raw !== 'string') continue
    const keyword = raw.trim()
    if (!keyword) continue
    if (keyword.length > 32) fail(400, 40001, 'each keyword must be at most 32 characters')
    const key = keyword.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(keyword)
    if (result.length >= 20) break
  }
  return result
}

function sanitizeExtra(input) {
  if (input === undefined || input === null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) fail(400, 40001, 'extra must be an object')
  if (stableStringify(input).length > 4096) fail(400, 40001, 'extra must be at most 4KB')
  return input
}

function sanitizeFilters(input) {
  if (input === undefined || input === null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) fail(400, 40001, 'filters must be an object')
  const filters = {}
  if (Array.isArray(input.session_ids)) {
    filters.session_ids = input.session_ids.filter((value) => typeof value === 'string' && value).slice(0, 100)
  } else if (Array.isArray(input.sessionIds)) {
    filters.session_ids = input.sessionIds.filter((value) => typeof value === 'string' && value).slice(0, 100)
  }
  if (Array.isArray(input.sources)) {
    filters.sources = input.sources.filter((value) => typeof value === 'string' && value).slice(0, 20)
  }
  const range = input.time_range ?? input.timeRange
  if (range !== undefined) {
    if (!range || typeof range !== 'object' || Array.isArray(range)) fail(400, 40001, 'time_range must be an object')
    const from = range.from === null || range.from === undefined ? null : parseTime(range.from)
    const to = range.to === null || range.to === undefined ? null : parseTime(range.to)
    if (range.from !== undefined && range.from !== null && from === null) fail(400, 40001, 'time_range.from is invalid')
    if (range.to !== undefined && range.to !== null && to === null) fail(400, 40001, 'time_range.to is invalid')
    filters.time_range = { from: from === null ? null : new Date(from).toISOString(), to: to === null ? null : new Date(to).toISOString() }
  }
  return filters
}

function normalizeScope(value) {
  const scope = value ?? 'user'
  if (scope !== 'user' && scope !== 'session' && scope !== 'global') fail(400, 40001, 'scope must be user, session, or global')
  return scope
}

function normalizeTtl(value) {
  if (value === undefined || value === null || value === '') return null
  const ttl = asInt(value, 0, 60, 31536000)
  if (!ttl) fail(400, 40001, 'ttl_seconds must be between 60 and 31536000')
  return ttl
}

function serializeRecord(record, options = {}) {
  const data = {
    id: record.id,
    user_id: record.userId,
    session_id: record.sessionId,
    content: record.content,
    keywords: record.keywords,
    source: record.source,
    extra: record.extra,
    version: record.version,
    embed_status: record.embedStatus,
    embed_source: record.embedSource,
    score: record.score,
    expire_at: record.expireAt,
    deleted_at: record.deletedAt,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  }
  if (options.includeEmbedding && record.embedding) {
    const vector = decodeVector(record.embedding)
    data.embedding = vector ? Array.from(vector) : null
  }
  return data
}

function parseWindow(value) {
  if (typeof value === 'number') return Math.max(1000, value * 1000)
  if (typeof value !== 'string' || !value.trim()) return 300000
  const match = value.trim().match(/^(\d+)\s*(ms|s|m|h)?$/i)
  if (!match) return 300000
  const amount = Number(match[1])
  const unit = (match[2] ?? 's').toLowerCase()
  if (unit === 'ms') return clamp(amount, 1000, 3600000)
  if (unit === 'm') return clamp(amount * 60000, 1000, 3600000)
  if (unit === 'h') return clamp(amount * 3600000, 1000, 3600000)
  return clamp(amount * 1000, 1000, 3600000)
}

function rrfFuse(semantic, keyword, wSemantic, wKeyword, k) {
  const byId = new Map()
  const semWeight = semantic.length ? (keyword.length ? wSemantic : 1) : 0
  const kwWeight = keyword.length ? (semantic.length ? wKeyword : 1) : 0
  for (const item of semantic) {
    byId.set(item.id, {
      id: item.id,
      score: semWeight / (k + item.rank),
      semantic: item.score,
      keyword: null,
      semanticRank: item.rank,
      keywordRank: null,
    })
  }
  for (const item of keyword) {
    const existing = byId.get(item.id)
    if (existing) {
      existing.score += kwWeight / (k + item.rank)
      existing.keyword = item.score
      existing.keywordRank = item.rank
    } else {
      byId.set(item.id, {
        id: item.id,
        score: kwWeight / (k + item.rank),
        semantic: null,
        keyword: item.score,
        semanticRank: null,
        keywordRank: item.rank,
      })
    }
  }
  return [...byId.values()].sort((left, right) => right.score - left.score)
}

function timeoutPromise(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    if (typeof timer?.unref === 'function') timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export class MemoryService {
  constructor(options) {
    this.store = options.store
    this.cache = options.cache
    this.embedder = options.embedder
    this.config = options.config
    this.logger = options.logger
    this.inflight = new Map()
    this.versionChain = Promise.resolve()
    this.startedAt = Date.now()
    this.counters = { reads: 0, writes: 0, searches: 0, degraded: 0, reembeds: 0 }
  }

  resolveUserId(input) {
    if (input !== undefined && input !== null && input !== '') {
      if (typeof input !== 'string' || input.length > 64) fail(400, 40001, 'user_id must be a string of at most 64 characters')
      if (input !== this.config.userId) fail(403, 40301, 'user_id does not match the configured owner')
      return input
    }
    return this.config.userId
  }

  normalizeWriteInput(input) {
    if (!input || typeof input !== 'object') fail(400, 40001, 'request body must be an object')
    const userId = this.resolveUserId(input.user_id ?? input.userId)
    const rawContent = input.content
    if (typeof rawContent !== 'string') fail(400, 40001, 'content is required')
    if (rawContent.length > 8000) fail(400, 40001, 'content must be at most 8000 characters')
    const normalized = normalizeText(rawContent)
    if (!normalized) fail(400, 40001, 'content must not be empty')
    const content = this.config.security.piiMask ? maskPII(normalized) : normalized
    if (!content.trim()) fail(422, 42201, 'content is empty after masking')
    const sessionId = String(input.session_id ?? input.sessionId ?? 'default').trim()
    if (!sessionId || sessionId.length > 128) fail(400, 40001, 'session_id must be 1-128 characters')
    const source = String(input.source ?? 'chat').trim().slice(0, 64) || 'chat'
    const keywords = sanitizeKeywords(input.keywords)
    const extra = sanitizeExtra(input.extra)
    const ttlSeconds = normalizeTtl(input.ttl_seconds ?? input.ttlSeconds)
    const needEmbedding = asBool(input.need_embedding ?? input.needEmbedding, true)
    const needKeywords = asBool(input.need_keywords ?? input.needKeywords, true)
    return { userId, content, sessionId, source, keywords, extra, ttlSeconds, needEmbedding, needKeywords }
  }

  prepareRecord(input) {
    const normalized = this.normalizeWriteInput(input)
    const contentHash = sha1(`${normalized.userId}|${normalized.sessionId}|${normalized.content}`)
    const duplicate = this.store.findByHash(normalized.userId, contentHash)
    if (duplicate) {
      return {
        duplicate,
        record: duplicate,
        meta: normalized,
      }
    }
    let keywords = normalized.keywords
    if (normalized.needKeywords) {
      const extracted = extractKeywords(normalized.content, 8)
      const seen = new Set(keywords.map((keyword) => keyword.toLowerCase()))
      for (const keyword of extracted) {
        if (seen.has(keyword)) continue
        seen.add(keyword)
        keywords.push(keyword)
        if (keywords.length >= 20) break
      }
    }
    const now = nowIso()
    const record = {
      id: uuid(),
      userId: normalized.userId,
      sessionId: normalized.sessionId,
      content: normalized.content,
      contentHash,
      keywords,
      embedding: null,
      embedStatus: normalized.needEmbedding ? 'pending' : 'ok',
      embedSource: normalized.needEmbedding ? 'unavailable' : 'disabled',
      source: normalized.source,
      extra: normalized.extra,
      score: null,
      expireAt: normalized.ttlSeconds ? new Date(Date.now() + normalized.ttlSeconds * 1000).toISOString() : null,
      version: 1,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    return { duplicate: null, record, meta: normalized }
  }

  async embedPrepared(preparedList) {
    const pending = preparedList.filter((item) => !item.duplicate && item.meta.needEmbedding)
    if (!pending.length) return { error: null }
    const result = await this.embedder.embedMany(pending.map((item) => item.meta.content))
    let index = 0
    for (const item of pending) {
      const vector = result.vectors[index]
      const source = result.sources[index] ?? 'unavailable'
      index += 1
      if (vector) {
        this.store.setEmbedding(item.record, vector, source)
      } else {
        item.record.embedStatus = 'pending'
        item.record.embedSource = 'unavailable'
      }
    }
    return { error: result.error }
  }

  async write(input) {
    const prepared = this.prepareRecord(input)
    if (prepared.duplicate) {
      this.counters.reads += 1
      return {
        id: prepared.duplicate.id,
        version: prepared.duplicate.version,
        deduplicated: true,
        embed_status: prepared.duplicate.embedStatus,
        embed_source: prepared.duplicate.embedSource,
        keywords: prepared.duplicate.keywords,
        index_version: await this.currentVersion(prepared.duplicate.userId),
        created_at: prepared.duplicate.createdAt,
      }
    }
    const { error } = await this.embedPrepared([prepared])
    const record = prepared.record
    await this.store.addRecord(record)
    const version = await this.bumpVersion(record.userId)
    await this.store.audit('write', record.userId, record.id)
    this.counters.writes += 1
    return {
      id: record.id,
      version: record.version,
      deduplicated: false,
      embed_status: record.embedStatus,
      embed_source: record.embedSource,
      keywords: record.keywords,
      index_version: version,
      created_at: record.createdAt,
      ...(error ? { warning: `embedding unavailable: ${error}` } : {}),
    }
  }

  async batchWrite(input) {
    if (!input || typeof input !== 'object') fail(400, 40001, 'request body must be an object')
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) {
      fail(400, 40001, 'items must contain 1-100 entries')
    }
    const atomic = asBool(input.atomic, false)
    const owner = this.resolveUserId(input.items[0]?.user_id ?? input.items[0]?.userId)
    for (const item of input.items) {
      const itemUser = item?.user_id ?? item?.userId
      if (itemUser !== undefined && itemUser !== owner) fail(400, 40001, 'all items must share one user_id')
    }
    const prepared = []
    const failures = []
    const withinBatch = new Map()
    for (let index = 0; index < input.items.length; index += 1) {
      try {
        const item = { ...input.items[index], user_id: owner }
        const result = this.prepareRecord(item)
        if (result.duplicate) {
          prepared.push({ ...result, index, duplicate: result.duplicate })
          continue
        }
        const existing = withinBatch.get(result.record.contentHash)
        if (existing) {
          prepared.push({
            index,
            duplicate: { id: existing.record.id, version: existing.record.version, embedStatus: 'pending', embedSource: 'unavailable', keywords: existing.record.keywords, createdAt: existing.record.createdAt, userId: owner },
            record: existing.record,
            meta: result.meta,
          })
          continue
        }
        withinBatch.set(result.record.contentHash, result)
        prepared.push({ ...result, index })
      } catch (error) {
        failures.push({ index, error })
      }
    }
    if (atomic && failures.length > 0) {
      fail(409, 40903, `atomic batch failed: ${failures[0].error.message}`)
    }
    const newItems = prepared.filter((item) => !item.duplicate)
    const embedResult = await this.embedPrepared(newItems)
    const responseItems = new Array(input.items.length)
    for (const failure of failures) {
      responseItems[failure.index] = {
        index: failure.index,
        id: null,
        status: 'failed',
        error_code: failure.error instanceof ApiError ? failure.error.code : 50000,
        message: failure.error.message,
      }
    }
    let succeeded = 0
    let failed = failures.length
    let created = 0
    for (const item of prepared) {
      if (item.duplicate) {
        responseItems[item.index] = { index: item.index, id: item.duplicate.id, status: 'duplicated' }
        succeeded += 1
        continue
      }
      try {
        await this.store.addRecord(item.record)
        created += 1
        succeeded += 1
        responseItems[item.index] = { index: item.index, id: item.record.id, status: 'created' }
      } catch (error) {
        failed += 1
        responseItems[item.index] = {
          index: item.index,
          id: null,
          status: 'failed',
          error_code: 50000,
          message: error.message,
        }
      }
    }
    if (atomic && created < newItems.length) {
      // Best-effort rollback of the records this call created.
      for (const item of newItems) {
        if (responseItems[item.index]?.status !== 'created') continue
        try {
          await this.store.hardDelete(item.record.id)
        } catch {}
      }
      fail(409, 40903, 'atomic batch failed while persisting records')
    }
    const indexVersion = created > 0 ? await this.bumpVersion(owner) : await this.currentVersion(owner)
    if (created > 0) await this.store.audit('batch_write', owner, null)
    this.counters.writes += created
    const embedStatus = newItems.some((item) => item.record.embedStatus !== 'ok') ? 'pending' : 'ok'
    return {
      total: input.items.length,
      succeeded,
      failed,
      embed_status: embedStatus,
      index_version: indexVersion,
      items: responseItems,
      ...(embedResult.error ? { warning: `embedding unavailable: ${embedResult.error}` } : {}),
    }
  }

  normalizeSearchInput(input) {
    if (!input || typeof input !== 'object') fail(400, 40001, 'request body must be an object')
    const userId = this.resolveUserId(input.user_id ?? input.userId)
    if (typeof input.query !== 'string' || !input.query.trim()) fail(400, 40003, 'query must not be empty')
    if (input.query.length > 512) fail(400, 40003, 'query must be at most 512 characters')
    const query = normalizeQuery(input.query)
    if (!query) fail(400, 40003, 'query must not be empty')
    if (query.length > 512) fail(400, 40003, 'query must be at most 512 characters')
    const scope = normalizeScope(input.scope)
    const sessionId = input.session_id ?? input.sessionId ?? null
    if (scope === 'session' && (typeof sessionId !== 'string' || !sessionId)) {
      fail(400, 40001, 'session_id is required when scope=session')
    }
    const topk = asInt(input.topk, this.config.retrieval.defaultTopK, 1, 50)
    const candidateK = asInt(
      input.candidate_k ?? input.candidateK,
      Math.max(topk * this.config.retrieval.candidateMultiplier, 20),
      1,
      200,
    )
    const minScore = asFloat(input.min_score ?? input.minScore, 0, 0, 1)
    let wSemantic = asFloat(input.w_semantic ?? input.wSemantic, this.config.retrieval.wSemantic, 0, 10)
    let wKeyword = asFloat(input.w_keyword ?? input.wKeyword, this.config.retrieval.wKeyword, 0, 10)
    if (wSemantic + wKeyword <= 0) fail(400, 40002, 'w_semantic + w_keyword must be greater than zero')
    const sum = wSemantic + wKeyword
    wSemantic /= sum
    wKeyword /= sum
    const filters = sanitizeFilters(input.filters)
    const includeEmbedding = asBool(input.include_embedding ?? input.includeEmbedding, false)
    const useCache = asBool(input.use_cache ?? input.useCache, true)
    return {
      userId,
      query,
      rawQuery: input.query,
      scope,
      sessionId,
      topk,
      candidateK,
      minScore,
      wSemantic,
      wKeyword,
      filters,
      includeEmbedding,
      useCache,
    }
  }

  async semanticSearch(request) {
    const embedded = await this.embedder.embedOne(request.query)
    if (!embedded.vector) throw new Error(embedded.error || 'embedding unavailable')
    const queryVector = l2Normalize(Float32Array.from(embedded.vector))
    const scored = []
    for (const entry of this.store.vectorEntries(request.userId)) {
      if (!this.store.matches(entry.record, request)) continue
      // Never compare vectors produced by different models: a local hashing
      // fallback vector is not in BGE-M3 space, and mixing them produces
      // plausible-looking but meaningless cosine similarity.
      if (embedded.source && entry.record.embedSource && entry.record.embedSource !== embedded.source) continue
      const similarity = clamp(cosine(queryVector, entry.vector), 0, 1)
      if (similarity <= 0) continue
      scored.push({ id: entry.record.id, score: similarity, raw: similarity })
    }
    scored.sort((left, right) => right.score - left.score)
    return {
      items: scored.slice(0, request.candidateK).map((item, index) => ({ ...item, rank: index + 1 })),
      warning: embedded.error || null,
      source: embedded.source,
    }
  }

  keywordSearch(request) {
    const allow = (id) => {
      const record = this.store.records.get(id)
      return this.store.matches(record, request)
    }
    return this.store.keyword.search(request.query, allow, request.candidateK)
  }

  cacheKey(request, version) {
    const filtersHash = hashFilters({
      scope: request.scope,
      sessionId: request.sessionId,
      filters: request.filters,
      topk: request.topk,
      candidateK: request.candidateK,
      minScore: request.minScore,
      wSemantic: request.wSemantic,
      wKeyword: request.wKeyword,
      includeEmbedding: request.includeEmbedding,
    })
    return `m:s:${sha256(`${request.userId}|${request.scope}|${request.query}|${request.topk}|${filtersHash}|${version}`)}`
  }

  async search(input) {
    const started = performance.now()
    const request = this.normalizeSearchInput(input)
    const version = await this.currentVersion(request.userId)
    const key = this.cacheKey(request, version)
    this.counters.searches += 1

    if (request.useCache) {
      const cached = await this.cache.get(key, { deferMiss: true })
      if (cached) {
        try {
          const payload = JSON.parse(cached.value)
          return this.buildSearchResponse(payload, {
            hit: true,
            level: cached.level,
            ageMs: cached.ageMs,
            started,
            version,
          })
        } catch {}
      }
    }

    if (request.useCache) {
      const shared = this.inflight.get(key)
      if (shared) {
        const waited = await Promise.race([shared.then(() => 'done').catch(() => 'failed'), sleep(this.config.cache.singleflightTimeoutMs)])
        if (waited === 'done') {
          const cached = await this.cache.get(key, { deferMiss: true })
          if (cached) {
            try {
              const payload = JSON.parse(cached.value)
              return this.buildSearchResponse(payload, {
                hit: true,
                level: cached.level,
                ageMs: cached.ageMs,
                started,
                version,
                coalesced: true,
              })
            } catch {}
          }
        }
      }
    }

    const compute = this.computeSearch(request, version)
    if (request.useCache) {
      this.inflight.set(key, compute)
      compute.finally(() => {
        if (this.inflight.get(key) === compute) this.inflight.delete(key)
      }).catch(() => {})
    }
    let payload
    try {
      payload = await compute
    } catch (error) {
      if (request.useCache) this.cache.recordMiss(performance.now() - started)
      throw error
    }
    if (request.useCache) this.cache.recordMiss(performance.now() - started)
    // Never cache a degraded response for the full search TTL: a temporary
    // embedding outage would otherwise pin keyword-only answers for minutes
    // after the provider recovers.
    if (request.useCache && !payload.degraded) {
      if (payload.total === 0) {
        this.cache.set(key, JSON.stringify(payload), this.config.cache.ttlNegative)
      } else {
        this.cache.set(key, JSON.stringify(payload), this.config.cache.ttlSearch)
      }
    }
    return this.buildSearchResponse(payload, {
      hit: false,
      level: null,
      ageMs: 0,
      started,
      version,
    })
  }

  buildSearchResponse(payload, cacheInfo) {
    return {
      query: payload.query,
      results: payload.results,
      total: payload.total,
      cache: {
        hit: Boolean(cacheInfo.hit),
        level: cacheInfo.level ?? null,
        age_ms: Math.max(0, Math.round(cacheInfo.ageMs ?? 0)),
        ...(cacheInfo.coalesced ? { coalesced: true } : {}),
      },
      degraded: Boolean(payload.degraded),
      degraded_reason: payload.degraded_reason ?? null,
      latency_ms: Number((performance.now() - cacheInfo.started).toFixed(2)),
      index_version: cacheInfo.version,
    }
  }

  async computeSearch(request, version) {
    const semanticTask = timeoutPromise(this.semanticSearch(request), this.config.retrieval.channelTimeoutMs, 'semantic channel')
    const keywordTask = timeoutPromise(Promise.resolve().then(() => this.keywordSearch(request)), this.config.retrieval.channelTimeoutMs, 'keyword channel')
    const [semanticResult, keywordResult] = await Promise.allSettled([semanticTask, keywordTask])
    const semanticValue = semanticResult.status === 'fulfilled' ? semanticResult.value : null
    const semantic = semanticValue?.items ?? []
    const keyword = keywordResult.status === 'fulfilled' ? keywordResult.value : []
    const reasons = []
    if (semanticResult.status === 'rejected') reasons.push(`semantic: ${semanticResult.reason?.message ?? semanticResult.reason}`)
    if (semanticValue?.warning) reasons.push(`semantic fallback (${semanticValue.source}): ${semanticValue.warning}`)
    if (keywordResult.status === 'rejected') reasons.push(`keyword: ${keywordResult.reason?.message ?? keywordResult.reason}`)
    if (semanticResult.status === 'rejected' && keywordResult.status === 'rejected') {
      this.counters.degraded += 1
      fail(503, 50301, `both retrieval channels failed: ${reasons.join('; ')}`)
    }
    if (reasons.length) this.counters.degraded += 1

    const fused = rrfFuse(semantic, keyword, request.wSemantic, request.wKeyword, this.config.retrieval.rrfK)
    const filtered = fused.filter((item) => item.semantic === null || item.semantic >= request.minScore)
    const results = []
    for (const item of filtered) {
      const record = this.store.records.get(item.id)
      if (!record || !this.store.matches(record, request)) continue
      const sources = []
      if (item.semantic !== null) sources.push('vector')
      if (item.keyword !== null) sources.push('keyword')
      results.push({
        id: record.id,
        content: record.content,
        keywords: record.keywords,
        session_id: record.sessionId,
        source: record.source,
        version: record.version,
        score: Number(item.score.toFixed(6)),
        scores: {
          semantic: item.semantic === null ? null : Number(item.semantic.toFixed(6)),
          keyword: item.keyword === null ? null : Number(item.keyword.toFixed(6)),
          semantic_rank: item.semanticRank,
          keyword_rank: item.keywordRank,
        },
        sources: sources.length === 2 ? ['both'] : sources,
        created_at: record.createdAt,
        meta: record.extra,
        ...(request.includeEmbedding
          ? { embedding: record.embedding ? Array.from(decodeVector(record.embedding) ?? []) : null, embed_status: record.embedStatus }
          : {}),
      })
      if (results.length >= request.topk) break
    }
    return {
      query: request.rawQuery,
      results,
      total: results.length,
      degraded: reasons.length > 0,
      degraded_reason: reasons.length ? reasons.join('; ') : null,
      index_version: version,
    }
  }

  async get(id, options = {}) {
    const record = this.store.getRecord(id, { includeDeleted: Boolean(options.includeDeleted) })
    if (!record) fail(404, 40401, 'memory not found')
    const user = this.resolveUserId(options.userId)
    if (record.userId !== user) fail(404, 40401, 'memory not found')
    this.counters.reads += 1
    return serializeRecord(record, { includeEmbedding: Boolean(options.includeEmbedding) })
  }

  async list(input = {}) {
    const userId = this.resolveUserId(input.user_id ?? input.userId)
    const limit = asInt(input.limit, 20, 1, 200)
    const sessionId = input.session_id ?? input.sessionId ?? null
    const cursor = typeof input.cursor === 'string' ? input.cursor : null
    const includeDeleted = asBool(input.include_deleted ?? input.includeDeleted, false)
    const page = this.store.listRecords(userId, { limit, sessionId, cursor, includeDeleted })
    this.counters.reads += 1
    return {
      items: page.items.map((record) => serializeRecord(record)),
      next_cursor: page.nextCursor,
      total: page.total,
    }
  }

  async update(id, input) {
    if (!input || typeof input !== 'object') fail(400, 40001, 'request body must be an object')
    const record = this.store.getRecord(id)
    if (!record) fail(404, 40401, 'memory not found')
    const user = this.resolveUserId(input.user_id ?? input.userId ?? record.userId)
    if (record.userId !== user) fail(404, 40401, 'memory not found')
    if (input.version !== undefined && input.version !== null && Number(input.version) !== record.version) {
      fail(409, 40901, `version mismatch: current version is ${record.version}`)
    }
    const hasContent = Object.prototype.hasOwnProperty.call(input, 'content')
    const hasKeywords = Object.prototype.hasOwnProperty.call(input, 'keywords')
    const hasExtra = Object.prototype.hasOwnProperty.call(input, 'extra')
    const hasTtl = Object.prototype.hasOwnProperty.call(input, 'ttl_seconds') || Object.prototype.hasOwnProperty.call(input, 'ttlSeconds')
    if (!hasContent && !hasKeywords && !hasExtra && !hasTtl) fail(400, 40001, 'at least one field must be provided')
    let next = { ...record, updatedAt: nowIso(), version: record.version + 1 }
    let embeddingError = null
    if (hasContent) {
      if (typeof input.content !== 'string') fail(400, 40001, 'content must be a string')
      const normalized = normalizeText(input.content)
      if (!normalized) fail(400, 40001, 'content must not be empty')
      const masked = this.config.security.piiMask ? maskPII(normalized) : normalized
      if (!masked.trim()) fail(422, 42201, 'content is empty after masking')
      const contentHash = sha1(`${record.userId}|${record.sessionId}|${masked}`)
      const duplicate = this.store.findByHash(record.userId, contentHash)
      if (duplicate && duplicate.id !== record.id) fail(409, 40902, 'another memory already has this content')
      next.content = masked
      next.contentHash = contentHash
      if (hasKeywords) {
        next.keywords = sanitizeKeywords(input.keywords)
      } else {
        const extracted = extractKeywords(masked, 8)
        next.keywords = extracted
      }
      const embedded = await this.embedder.embedOne(masked)
      if (embedded.vector) {
        this.store.setEmbedding(next, embedded.vector, embedded.source)
      } else {
        next.embedding = null
        next.embedStatus = 'pending'
        next.embedSource = 'unavailable'
        embeddingError = embedded.error
      }
    } else if (hasKeywords) {
      next.keywords = sanitizeKeywords(input.keywords)
    }
    if (hasExtra) next.extra = sanitizeExtra(input.extra)
    if (hasTtl) {
      const ttl = normalizeTtl(input.ttl_seconds ?? input.ttlSeconds)
      next.expireAt = ttl ? new Date(Date.now() + ttl * 1000).toISOString() : null
    }
    await this.store.updateRecord(next)
    const version = await this.bumpVersion(record.userId)
    await this.store.audit('update', record.userId, record.id)
    this.counters.writes += 1
    return {
      ...serializeRecord(next, { includeEmbedding: Boolean(input.include_embedding ?? input.includeEmbedding) }),
      index_version: version,
      ...(embeddingError ? { warning: `embedding unavailable: ${embeddingError}` } : {}),
    }
  }

  async remove(id, options = {}) {
    const record = this.store.getRecord(id, { includeDeleted: true })
    if (!record) fail(404, 40401, 'memory not found')
    const user = this.resolveUserId(options.userId ?? record.userId)
    if (record.userId !== user) fail(404, 40401, 'memory not found')
    const hard = asBool(options.hard, false)
    if (hard) {
      if (!this.config.security.allowHardDelete) fail(403, 40302, 'hard delete is disabled by configuration')
      await this.store.hardDelete(id)
      const indexVersion = await this.bumpVersion(record.userId)
      await this.store.audit('hard_delete', record.userId, id)
      this.counters.writes += 1
      return { id, deleted: true, hard: true, index_version: indexVersion }
    }
    if (record.deletedAt) {
      return { id, deleted: true, hard: false, index_version: await this.currentVersion(record.userId) }
    }
    const next = { ...record, deletedAt: nowIso(), updatedAt: nowIso(), version: record.version + 1 }
    await this.store.updateRecord(next)
    const indexVersion = await this.bumpVersion(record.userId)
    await this.store.audit('delete', record.userId, id)
    this.counters.writes += 1
    return { id, deleted: true, hard: false, index_version: indexVersion }
  }

  async currentVersion(userId) {
    const local = this.store.getVersion(userId)
    const remote = await this.cache.remoteVersion(userId)
    return remote !== null && remote > local ? remote : local
  }

  bumpVersion(userId) {
    // Serialize bumps so two concurrent writes cannot both publish the same
    // next version (which would leave one write's cache invalidation missing).
    const run = this.versionChain.then(async () => {
      const current = await this.currentVersion(userId)
      const next = current + 1
      await this.store.setVersion(userId, next)
      await this.cache.publishVersion(userId, next)
      return next
    })
    this.versionChain = run.then(() => undefined, () => undefined)
    return run
  }

  async stats(input = {}) {
    const userId = this.resolveUserId(input.user_id ?? input.userId)
    const windowMs = parseWindow(input.window)
    const cacheStats = this.cache.stats(windowMs)
    const counts = this.store.count(userId)
    return {
      window: input.window ?? '300s',
      user_id: userId,
      memories: counts,
      cache: cacheStats,
      embedding: this.embedder.info(),
      index_version: await this.currentVersion(userId),
      uptime_s: Math.round((Date.now() - this.startedAt) / 1000),
      counters: { ...this.counters },
    }
  }

  async health(input = {}) {
    const userId = this.resolveUserId(input.user_id ?? input.userId)
    const embedding = this.embedder.info()
    const cache = this.cache.stats(300000)
    return {
      ok: true,
      build: BUILD,
      storage: { ok: true, memories: this.store.count(userId).active },
      embedding: {
        ok: embedding.state !== 'degraded' && embedding.state !== 'unavailable',
        ...embedding,
      },
      cache: {
        ok: true,
        l3: cache.l3,
        hit_rate: cache.hit_rate,
      },
      index_version: await this.currentVersion(userId),
    }
  }

  async purgeCache(input = {}) {
    const level = ['all', 'l1', 'l2', 'l3'].includes(input.level) ? input.level : 'all'
    const scope = input.scope === 'user' ? 'user' : 'all'
    const userId = this.resolveUserId(input.user_id ?? input.userId)
    let indexVersion = await this.currentVersion(userId)
    if (scope === 'user') indexVersion = await this.bumpVersion(userId)
    const result = await this.cache.purge(level, scope)
    await this.store.audit('purge_cache', userId, null)
    return { ...result, scope, user_id: userId, index_version: indexVersion }
  }

  async reembed(input = {}) {
    const userId = this.resolveUserId(input.user_id ?? input.userId)
    const limit = asInt(input.limit, 50, 1, 200)
    const force = asBool(input.force, false)
    const candidates = []
    for (const record of this.store.records.values()) {
      if (record.userId !== userId) continue
      if (!this.store.isActive(record)) continue
      if (!force && record.embedStatus === 'ok') continue
      candidates.push(record)
      if (candidates.length >= limit) break
    }
    let ok = 0
    let failed = 0
    for (const record of candidates) {
      try {
        const embedded = await this.embedder.embedOne(record.content)
        if (!embedded.vector) {
          failed += 1
          continue
        }
        const next = { ...record, updatedAt: nowIso() }
        this.store.setEmbedding(next, embedded.vector, embedded.source)
        await this.store.updateRecord(next)
        ok += 1
      } catch {
        failed += 1
      }
    }
    if (ok > 0) await this.bumpVersion(userId)
    if (candidates.length) await this.store.audit('reembed', userId, null)
    this.counters.reembeds += ok
    return { scanned: candidates.length, succeeded: ok, failed, force, index_version: await this.currentVersion(userId) }
  }

  async sweep() {
    return this.store.sweep()
  }

  async embeddingStatus() {
    return this.embedder.info()
  }
}
