/** Durable memory records and the derived in-memory retrieval indexes. */
import { KeywordIndex } from './keyword.js'
import {
  decodeVector,
  encodeVector,
  nowIso,
  parseTime,
  sha1,
  uuid,
} from './util.js'

const UNIT_NAME = 'dsh_memory'
const UNIT_VERSION = 1
const TABLES = ['memories', 'versions', 'idempotency', 'audit']

function validRecord(raw) {
  if (!raw || typeof raw !== 'object') return false
  if (typeof raw.id !== 'string' || !raw.id) return false
  if (typeof raw.userId !== 'string' || !raw.userId) return false
  if (typeof raw.sessionId !== 'string') return false
  if (typeof raw.content !== 'string') return false
  if (typeof raw.contentHash !== 'string') return false
  if (!Array.isArray(raw.keywords)) return false
  return true
}

export class MemoryStore {
  constructor(options) {
    this.storage = options.storage
    this.logger = options.logger
    this.records = new Map()
    this.hashIndex = new Map()
    this.versions = new Map()
    this.idempotency = new Map()
    this.auditKeys = []
    this.keyword = new KeywordIndex()
    this.vectors = new Map()
    this.unit = null
    this.chain = Promise.resolve()
    this.closed = false
  }

  async open() {
    let backend = null
    try {
      backend = this.storage.backend.get('json')
    } catch {}
    if (!backend?.kv) {
      for (const name of this.storage.backend.names()) {
        const candidate = this.storage.backend.get(name)
        if (candidate?.kv) {
          backend = candidate
          break
        }
      }
    }
    if (!backend?.kv) throw new Error('no storage backend with a kv facet is mounted')
    this.unit = await backend.kv.open({
      name: UNIT_NAME,
      version: UNIT_VERSION,
      tables: TABLES,
      hasGlobal: false,
      layout: 'per-record',
    })
    const snapshot = await this.unit.loadAll()
    const memories = snapshot.tables.memories ?? {}
    for (const [id, raw] of Object.entries(memories)) {
      if (!validRecord(raw)) {
        this.logger?.warn?.(`[memory] skipping malformed memory record ${id}`)
        continue
      }
      const record = this.normalizeLoadedRecord(raw)
      this.records.set(record.id, record)
      this.indexRecord(record)
    }
    for (const [key, raw] of Object.entries(snapshot.tables.versions ?? {})) {
      if (!raw || typeof raw.userId !== 'string' || !Number.isFinite(raw.version)) continue
      this.versions.set(raw.userId, {
        userId: raw.userId,
        version: Math.max(1, Math.trunc(raw.version)),
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
      })
      void key
    }
    for (const [key, raw] of Object.entries(snapshot.tables.idempotency ?? {})) {
      if (!raw || typeof raw.key !== 'string' || typeof raw.createdAt !== 'string') continue
      this.idempotency.set(raw.key, raw)
      void key
    }
    for (const key of Object.keys(snapshot.tables.audit ?? {})) {
      this.auditKeys.push(key)
    }
    this.auditKeys.sort()
    this.logger?.info?.(`[memory] loaded ${this.records.size} memories (${this.keyword.size} indexed)`)
  }

  normalizeLoadedRecord(raw) {
    return {
      id: raw.id,
      userId: raw.userId,
      sessionId: raw.sessionId,
      content: raw.content,
      contentHash: raw.contentHash,
      keywords: raw.keywords.filter((keyword) => typeof keyword === 'string'),
      embedding: typeof raw.embedding === 'string' && raw.embedding ? raw.embedding : null,
      embedStatus: raw.embedStatus === 'ok' || raw.embedStatus === 'failed' ? raw.embedStatus : 'pending',
      embedSource: typeof raw.embedSource === 'string' ? raw.embedSource : 'unknown',
      source: typeof raw.source === 'string' ? raw.source : 'chat',
      extra: raw.extra && typeof raw.extra === 'object' && !Array.isArray(raw.extra) ? raw.extra : {},
      score: Number.isFinite(raw.score) ? raw.score : null,
      expireAt: typeof raw.expireAt === 'string' ? raw.expireAt : null,
      version: Number.isFinite(raw.version) ? raw.version : 1,
      deletedAt: typeof raw.deletedAt === 'string' ? raw.deletedAt : null,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
    }
  }

  isActive(record, now = Date.now()) {
    if (!record || record.deletedAt) return false
    if (record.expireAt) {
      const expires = parseTime(record.expireAt)
      if (expires !== null && expires <= now) return false
    }
    return true
  }

  indexRecord(record) {
    if (!this.isActive(record)) return
    this.hashIndex.set(`${record.userId}|${record.contentHash}`, record.id)
    this.keyword.add(record)
    if (record.embedding) {
      const vector = decodeVector(record.embedding)
      if (vector) this.vectors.set(record.id, vector)
      else this.vectors.delete(record.id)
    } else {
      this.vectors.delete(record.id)
    }
  }

  unindexRecord(record) {
    if (!record) return
    const key = `${record.userId}|${record.contentHash}`
    if (this.hashIndex.get(key) === record.id) this.hashIndex.delete(key)
    this.keyword.remove(record.id)
    this.vectors.delete(record.id)
  }

  getRecord(id, options = {}) {
    const record = this.records.get(id)
    if (!record) return null
    if (!options.includeDeleted && record.deletedAt) return null
    return record
  }

  findByHash(userId, contentHash) {
    const id = this.hashIndex.get(`${userId}|${contentHash}`)
    if (!id) return null
    const record = this.records.get(id)
    return record && this.isActive(record) ? record : null
  }

  listRecords(userId, options = {}) {
    const now = Date.now()
    const limit = Math.max(1, Math.min(200, options.limit ?? 20))
    const sessionId = options.sessionId
    const rows = []
    for (const record of this.records.values()) {
      if (record.userId !== userId) continue
      if (!options.includeDeleted && !this.isActive(record, now)) continue
      if (sessionId && record.sessionId !== sessionId) continue
      rows.push(record)
    }
    rows.sort((left, right) => {
      const leftTime = parseTime(left.createdAt) ?? 0
      const rightTime = parseTime(right.createdAt) ?? 0
      if (leftTime !== rightTime) return rightTime - leftTime
      return left.id < right.id ? 1 : -1
    })
    let start = 0
    if (options.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'))
        const index = rows.findIndex((record) => record.id === decoded.id)
        if (index >= 0) start = index + 1
      } catch {}
    }
    const items = rows.slice(start, start + limit)
    const next = start + limit < rows.length
      ? Buffer.from(JSON.stringify({ id: items[items.length - 1]?.id })).toString('base64url')
      : null
    return { items, nextCursor: next, total: rows.length }
  }

  count(userId) {
    let active = 0
    let deleted = 0
    let expired = 0
    let pending = 0
    let total = 0
    const now = Date.now()
    for (const record of this.records.values()) {
      if (record.userId !== userId) continue
      total += 1
      if (record.deletedAt) {
        deleted += 1
        continue
      }
      if (record.expireAt) {
        const expires = parseTime(record.expireAt)
        if (expires !== null && expires <= now) {
          expired += 1
          continue
        }
      }
      active += 1
      if (record.embedStatus !== 'ok') pending += 1
    }
    return { active, deleted, expired, pending, total }
  }

  matches(record, query) {
    if (!this.isActive(record)) return false
    if (record.userId !== query.userId) return false
    if (query.scope === 'session' && record.sessionId !== query.sessionId) return false
    const filters = query.filters ?? {}
    if (Array.isArray(filters.session_ids) && filters.session_ids.length > 0) {
      if (!filters.session_ids.includes(record.sessionId)) return false
    }
    if (Array.isArray(filters.sources) && filters.sources.length > 0) {
      if (!filters.sources.includes(record.source)) return false
    }
    const range = filters.time_range
    if (range && typeof range === 'object') {
      const from = parseTime(range.from)
      const to = parseTime(range.to)
      const created = parseTime(record.createdAt)
      if (created === null) return false
      if (from !== null && created < from) return false
      if (to !== null && created > to) return false
    }
    return true
  }

  mutate(job) {
    if (this.closed) return Promise.reject(new Error('memory store is closed'))
    const run = this.chain.then(job)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  addRecord(record) {
    return this.mutate(async () => {
      await this.unit.putRecord('memories', record.id, record)
      this.records.set(record.id, record)
      this.indexRecord(record)
      return record
    })
  }

  updateRecord(record) {
    return this.mutate(async () => {
      const previous = this.records.get(record.id)
      await this.unit.putRecord('memories', record.id, record)
      if (previous) this.unindexRecord(previous)
      this.records.set(record.id, record)
      this.indexRecord(record)
      return record
    })
  }

  softDelete(record) {
    return this.updateRecord(record)
  }

  hardDelete(id) {
    return this.mutate(async () => {
      const previous = this.records.get(id)
      await this.unit.deleteRecord('memories', id)
      if (previous) this.unindexRecord(previous)
      this.records.delete(id)
      return previous ?? null
    })
  }

  getVersion(userId) {
    return this.versions.get(userId)?.version ?? 1
  }

  async setVersion(userId, version) {
    const entry = { userId, version: Math.max(1, Math.trunc(version)), updatedAt: nowIso() }
    await this.unit.putRecord('versions', sha1(userId), entry)
    this.versions.set(userId, entry)
    return entry.version
  }

  getIdempotency(key) {
    return this.idempotency.get(key) ?? null
  }

  async putIdempotency(key, record) {
    await this.unit.putRecord('idempotency', sha1(key), record)
    this.idempotency.set(key, record)
  }

  async audit(action, userId, targetId) {
    try {
      const key = `${Date.now()}-${uuid()}`
      const entry = { id: key, action, userId, targetId: targetId ?? null, at: nowIso() }
      await this.unit.putRecord('audit', key, entry)
      this.auditKeys.push(key)
      while (this.auditKeys.length > 1000) {
        const oldest = this.auditKeys.shift()
        if (oldest) await this.unit.deleteRecord('audit', oldest)
      }
    } catch (error) {
      this.logger?.warn?.(`[memory] audit write failed: ${error.message}`)
    }
  }

  async sweep() {
    const now = Date.now()
    const expired = []
    for (const record of this.records.values()) {
      if (record.deletedAt || !record.expireAt) continue
      const expires = parseTime(record.expireAt)
      if (expires !== null && expires <= now) expired.push(record)
    }
    if (expired.length) {
      await this.mutate(async () => {
        for (const record of expired) {
          const next = { ...record, deletedAt: nowIso(), updatedAt: nowIso(), version: record.version + 1 }
          await this.unit.putRecord('memories', record.id, next)
          this.unindexRecord(record)
          this.records.set(record.id, next)
        }
      })
    }
    const idempotencyCutoff = now - 24 * 3600 * 1000
    for (const [key, entry] of [...this.idempotency.entries()]) {
      const created = parseTime(entry.createdAt)
      if (created !== null && created < idempotencyCutoff) {
        await this.unit.deleteRecord('idempotency', sha1(key))
        this.idempotency.delete(key)
      }
    }
    const auditCutoff = now - 30 * 24 * 3600 * 1000
    while (this.auditKeys.length) {
      const key = this.auditKeys[0]
      const timestamp = Number.parseInt(key.slice(0, key.indexOf('-')), 10)
      if (!Number.isFinite(timestamp) || timestamp >= auditCutoff) break
      this.auditKeys.shift()
      await this.unit.deleteRecord('audit', key)
    }
    return { expired: expired.length }
  }

  vectorEntries(userId) {
    const entries = []
    for (const record of this.records.values()) {
      if (record.userId !== userId) continue
      if (!this.isActive(record)) continue
      const vector = this.vectors.get(record.id)
      if (!vector) continue
      entries.push({ record, vector })
    }
    return entries
  }

  async close() {
    this.closed = true
    try {
      await this.chain
    } catch {}
    if (this.unit) {
      try {
        await this.unit.close()
      } catch {}
    }
  }

  embedVector(record) {
    if (!record?.embedding) return null
    return this.vectors.get(record.id) ?? decodeVector(record.embedding)
  }

  setEmbedding(record, vector, source) {
    record.embedding = vector ? encodeVector(vector) : null
    record.embedStatus = vector ? 'ok' : 'pending'
    record.embedSource = source ?? record.embedSource ?? 'unknown'
    if (vector) this.vectors.set(record.id, vector)
    else this.vectors.delete(record.id)
  }
}
