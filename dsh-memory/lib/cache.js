/** Three-tier cache: L1 process LRU, L2 local JSON file, L3 optional Redis. */
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { percentile } from './util.js'

const CRLF = Buffer.from('\r\n')
const BUCKET_MS = 5000
const WINDOW_MAX_MS = 3600000
const LATENCY_SAMPLES = 2048

function encodeCommand(args) {
  const parts = [`*${args.length}\r\n`]
  for (const arg of args) {
    const value = Buffer.isBuffer(arg) ? arg : Buffer.from(String(arg), 'utf8')
    parts.push(`$${value.length}\r\n`)
    parts.push(value)
    parts.push('\r\n')
  }
  return Buffer.concat(parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part, 'utf8'))))
}

class RedisL3 {
  constructor(uri, logger, timeoutMs = 1500) {
    this.uri = uri
    this.logger = logger
    this.timeoutMs = timeoutMs
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.pending = []
    this.connecting = null
    this.connected = false
    this.cooldownUntil = 0
    this.lastError = null
    this.lastOkAt = null
    this.trackedKeys = new Set()
    const parsed = new URL(uri)
    this.protocol = parsed.protocol
    this.host = parsed.hostname
    this.port = Number(parsed.port || 6379)
    this.username = decodeURIComponent(parsed.username || '')
    this.password = decodeURIComponent(parsed.password || '')
    this.database = Number((parsed.pathname || '/0').replace(/^\//, '') || 0)
  }

  status() {
    return {
      enabled: true,
      connected: this.connected,
      error: this.lastError,
      last_ok_at: this.lastOkAt,
      keys: this.trackedKeys.size,
    }
  }

  async ensureConnected() {
    if (this.connected && this.socket) return
    if (Date.now() < this.cooldownUntil) throw new Error(this.lastError || 'redis cooldown')
    if (this.connecting) return this.connecting
    this.connecting = this.connect().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  connect() {
    return new Promise((resolve, reject) => {
      const options = { host: this.host, port: this.port }
      const socket = this.protocol === 'rediss:'
        ? tls.connect({ ...options, servername: this.host })
        : net.createConnection(options)
      let settled = false
      const fail = (error) => {
        if (settled) return
        settled = true
        this.lastError = error?.message || String(error)
        this.cooldownUntil = Date.now() + 5000
        this.connected = false
        try {
          socket.destroy()
        } catch {}
        reject(error)
      }
      const ready = async () => {
        try {
          this.socket = socket
          this.connected = true
          socket.on('data', (chunk) => this.onData(chunk))
          socket.on('error', (error) => this.onSocketError(error))
          socket.on('close', () => this.onSocketError(new Error('redis connection closed')))
          if (this.password) {
            await this.sendCommand(this.username ? ['AUTH', this.username, this.password] : ['AUTH', this.password])
          }
          if (this.database) await this.sendCommand(['SELECT', String(this.database)])
          this.lastError = null
          this.cooldownUntil = 0
          settled = true
          resolve()
        } catch (error) {
          fail(error)
        }
      }
      if (this.protocol === 'rediss:') socket.once('secureConnect', ready)
      else socket.once('connect', ready)
      socket.once('error', fail)
      socket.setTimeout(0)
    })
  }

  onSocketError(error) {
    this.connected = false
    this.lastError = error?.message || String(error)
    this.cooldownUntil = Date.now() + 5000
    this.socket = null
    const pending = this.pending
    this.pending = []
    for (const item of pending) {
      clearTimeout(item.timer)
      item.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const parsed = this.parseAt(0)
      if (!parsed) break
      const [value, next] = parsed
      this.buffer = this.buffer.subarray(next)
      const item = this.pending.shift()
      if (!item) continue
      clearTimeout(item.timer)
      if (value instanceof Error) item.reject(value)
      else item.resolve(value)
    }
  }

  parseAt(offset) {
    if (offset >= this.buffer.length) return null
    const lineEnd = this.buffer.indexOf(CRLF, offset)
    if (lineEnd < 0) return null
    const type = String.fromCharCode(this.buffer[offset])
    const line = this.buffer.toString('utf8', offset + 1, lineEnd)
    const nextLine = lineEnd + 2
    if (type === '+') return [line, nextLine]
    if (type === '-') return [new Error(line), nextLine]
    if (type === ':') return [Number(line), nextLine]
    if (type === '$') {
      const length = Number(line)
      if (length < 0) return [null, nextLine]
      if (this.buffer.length < nextLine + length + 2) return null
      const value = this.buffer.toString('utf8', nextLine, nextLine + length)
      return [value, nextLine + length + 2]
    }
    if (type === '*') {
      const count = Number(line)
      if (count < 0) return [null, nextLine]
      const items = []
      let cursor = nextLine
      for (let index = 0; index < count; index += 1) {
        const nested = this.parseAt(cursor)
        if (!nested) return null
        items.push(nested[0])
        cursor = nested[1]
      }
      return [items, cursor]
    }
    return [new Error(`redis protocol error near ${line}`), nextLine]
  }

  sendCommand(args) {
    if (!this.socket) return Promise.reject(new Error('redis not connected'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.onSocketError(new Error(`redis command timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      if (typeof timer?.unref === 'function') timer.unref()
      this.pending.push({ resolve, reject, timer })
      try {
        this.socket.write(encodeCommand(args))
      } catch (error) {
        clearTimeout(timer)
        this.pending.pop()
        reject(error)
      }
    })
  }

  async command(args) {
    await this.ensureConnected()
    const result = await this.sendCommand(args)
    this.lastOkAt = new Date().toISOString()
    return result
  }

  async ping() {
    return this.command(['PING'])
  }

  async get(key) {
    return this.command(['GET', key])
  }

  async set(key, value, ttlSeconds) {
    const args = ['SET', key, value]
    if (ttlSeconds > 0) args.push('EX', String(Math.max(1, Math.trunc(ttlSeconds))))
    const result = await this.command(args)
    if (result === 'OK') this.trackedKeys.add(key)
    return result
  }

  async del(keys) {
    if (!keys.length) return 0
    const result = await this.command(['DEL', ...keys])
    for (const key of keys) this.trackedKeys.delete(key)
    return result
  }

  async scan(match, limit = 5000) {
    const keys = []
    let cursor = '0'
    do {
      const reply = await this.command(['SCAN', cursor, 'MATCH', match, 'COUNT', '200'])
      if (!Array.isArray(reply)) break
      cursor = String(reply[0])
      const batch = Array.isArray(reply[1]) ? reply[1] : []
      for (const key of batch) {
        keys.push(String(key))
        if (keys.length >= limit) return keys
      }
    } while (cursor !== '0')
    return keys
  }

  close() {
    if (this.socket) {
      try {
        this.socket.destroy()
      } catch {}
      this.socket = null
    }
    this.connected = false
    this.onSocketError(new Error('redis client closed'))
  }
}

export class CacheStore {
  constructor(options) {
    this.config = options.config
    this.logger = options.logger
    this.l1 = new Map()
    this.l2 = new Map()
    this.l2File = this.resolveL2File(this.config.l2Path)
    this.l2Disabled = false
    this.l2Bytes = 0
    this.l2Timer = null
    this.l2Writing = null
    this.closed = false
    this.hits = { l1: 0, l2: 0, l3: 0 }
    this.misses = 0
    this.evictions = { lru: 0, ttl: 0 }
    this.embeddingCalls = { total: 0, cached: 0, api: 0, local: 0 }
    this.buckets = new Map()
    this.latencyHits = []
    this.latencyMisses = []
    this.l3 = null
    if (this.config.l3Url) {
      try {
        this.l3 = new RedisL3(this.config.l3Url, this.logger)
      } catch (error) {
        this.logger?.warn?.(`[memory] L3 disabled: ${error.message}`)
      }
    }
  }

  resolveL2File(configured) {
    if (configured && String(configured).trim()) return String(configured).trim()
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    return path.join(home, 'storages', 'dsh-memory', 'l2-cache.json')
  }

  async open() {
    await this.loadL2()
    if (this.l3) {
      try {
        await this.l3.ping()
      } catch (error) {
        this.logger?.warn?.(`[memory] L3 Redis unavailable: ${error.message}`)
      }
    }
  }

  async close() {
    this.closed = true
    if (this.l2Timer) {
      clearTimeout(this.l2Timer)
      this.l2Timer = null
    }
    try {
      await this.flushL2()
    } catch {}
    if (this.l2Writing) {
      try {
        await this.l2Writing
      } catch {}
    }
    this.l3?.close()
  }

  async loadL2() {
    try {
      const raw = await fs.readFile(this.l2File, 'utf8')
      const parsed = JSON.parse(raw)
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
      const now = Date.now()
      for (const entry of entries) {
        if (!entry || typeof entry.key !== 'string' || typeof entry.value !== 'string') continue
        if (!Number.isFinite(entry.expiresAt) || entry.expiresAt <= now) {
          this.evictions.ttl += 1
          continue
        }
        this.l2.set(entry.key, {
          value: entry.value,
          expiresAt: entry.expiresAt,
          storedAt: Number(entry.storedAt) || now,
          lastAccess: Number(entry.lastAccess) || now,
        })
        this.l2Bytes += Buffer.byteLength(entry.value, 'utf8')
      }
      await this.enforceL2Limits(now)
      this.logger?.info?.(`[memory] loaded ${this.l2.size} L2 cache entries`)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.l2Disabled = true
        this.logger?.warn?.(`[memory] L2 cache disabled: ${error.message}`)
      }
    }
  }

  scheduleL2Flush() {
    if (this.l2Disabled || this.closed || this.l2Timer) return
    this.l2Timer = setTimeout(() => {
      this.l2Timer = null
      this.flushL2().catch((error) => {
        this.logger?.warn?.(`[memory] L2 cache write failed: ${error.message}`)
      })
    }, 250)
    if (typeof this.l2Timer?.unref === 'function') this.l2Timer.unref()
  }

  async enforceL2Limits(now) {
    if (this.l2.size <= this.config.l2MaxEntries && this.l2Bytes <= this.config.l2MaxBytes) return
    const entries = [...this.l2.entries()].sort((left, right) => left[1].lastAccess - right[1].lastAccess)
    for (const [key, entry] of entries) {
      if (this.l2.size <= this.config.l2MaxEntries && this.l2Bytes <= this.config.l2MaxBytes) break
      this.l2.delete(key)
      this.l2Bytes = Math.max(0, this.l2Bytes - Buffer.byteLength(entry.value, 'utf8'))
      this.evictions.lru += 1
    }
  }

  async flushL2() {
    if (this.l2Disabled) return
    if (this.l2Writing) return this.l2Writing
    this.l2Writing = (async () => {
      const now = Date.now()
      for (const [key, entry] of this.l2) {
        if (entry.expiresAt <= now) {
          this.l2.delete(key)
          this.l2Bytes = Math.max(0, this.l2Bytes - Buffer.byteLength(entry.value, 'utf8'))
          this.evictions.ttl += 1
        }
      }
      await this.enforceL2Limits(now)
      const entries = [...this.l2.entries()].map(([key, entry]) => ({
        key,
        value: entry.value,
        expiresAt: entry.expiresAt,
        storedAt: entry.storedAt,
        lastAccess: entry.lastAccess,
      }))
      const serialized = JSON.stringify({ version: 1, entries })
      const directory = path.dirname(this.l2File)
      await fs.mkdir(directory, { recursive: true })
      const temp = `${this.l2File}.${process.pid}.tmp`
      await fs.writeFile(temp, serialized, 'utf8')
      try {
        await fs.rename(temp, this.l2File)
      } catch (error) {
        await fs.rm(temp, { force: true })
        throw error
      }
      this.l2Bytes = entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.value, 'utf8'), 0)
    })().finally(() => {
      this.l2Writing = null
    })
    return this.l2Writing
  }

  bucket(now) {
    const start = Math.floor(now / BUCKET_MS) * BUCKET_MS
    let bucket = this.buckets.get(start)
    if (!bucket) {
      bucket = {
        start,
        hits: { l1: 0, l2: 0, l3: 0 },
        misses: 0,
        embedding: { cached: 0, api: 0, local: 0 },
        latencies: [],
      }
      this.buckets.set(start, bucket)
      const cutoff = now - WINDOW_MAX_MS
      for (const key of this.buckets.keys()) if (key < cutoff) this.buckets.delete(key)
    }
    return bucket
  }

  recordHit(level, latencyMs) {
    this.hits[level] += 1
    const bucket = this.bucket(Date.now())
    bucket.hits[level] += 1
    bucket.latencies.push({ hit: true, ms: latencyMs })
    if (bucket.latencies.length > LATENCY_SAMPLES) bucket.latencies.shift()
    this.latencyHits.push({ at: Date.now(), ms: latencyMs })
    if (this.latencyHits.length > LATENCY_SAMPLES) this.latencyHits.shift()
  }

  recordMiss(latencyMs) {
    this.misses += 1
    const bucket = this.bucket(Date.now())
    bucket.misses += 1
    bucket.latencies.push({ hit: false, ms: latencyMs })
    if (bucket.latencies.length > LATENCY_SAMPLES) bucket.latencies.shift()
    this.latencyMisses.push({ at: Date.now(), ms: latencyMs })
    if (this.latencyMisses.length > LATENCY_SAMPLES) this.latencyMisses.shift()
  }

  recordEmbedding(kind) {
    this.embeddingCalls.total += 1
    if (kind in this.embeddingCalls) this.embeddingCalls[kind] += 1
    const bucket = this.bucket(Date.now())
    if (kind in bucket.embedding) bucket.embedding[kind] += 1
  }

  l1Get(key) {
    const entry = this.l1.get(key)
    if (!entry) return null
    const now = Date.now()
    if (entry.expiresAt <= now) {
      this.l1.delete(key)
      this.evictions.ttl += 1
      return null
    }
    this.l1.delete(key)
    this.l1.set(key, entry)
    return entry
  }

  l2Get(key) {
    const entry = this.l2.get(key)
    if (!entry) return null
    const now = Date.now()
    if (entry.expiresAt <= now) {
      this.l2.delete(key)
      this.l2Bytes = Math.max(0, this.l2Bytes - Buffer.byteLength(entry.value, 'utf8'))
      this.evictions.ttl += 1
      return null
    }
    entry.lastAccess = now
    return entry
  }

  l1Set(key, value, expiresAt, storedAt) {
    if (this.config.l1MaxEntries <= 0) return
    if (this.l1.has(key)) this.l1.delete(key)
    while (this.l1.size >= this.config.l1MaxEntries) {
      const oldest = this.l1.keys().next().value
      if (oldest === undefined) break
      this.l1.delete(oldest)
      this.evictions.lru += 1
    }
    this.l1.set(key, { value, expiresAt, storedAt, lastAccess: Date.now() })
  }

  l2Set(key, value, expiresAt, storedAt) {
    if (this.l2Disabled || this.config.l2MaxEntries <= 0) return
    if (this.l2.has(key)) {
      this.l2Bytes = Math.max(0, this.l2Bytes - Buffer.byteLength(this.l2.get(key).value, 'utf8'))
      this.l2.delete(key)
    }
    this.l2.set(key, { value, expiresAt, storedAt, lastAccess: Date.now() })
    this.l2Bytes += Buffer.byteLength(value, 'utf8')
    this.scheduleL2Flush()
  }

  jitterTtl(ttlSeconds) {
    const ratio = this.config.ttlJitterRatio
    if (!ratio) return Math.max(1, Math.trunc(ttlSeconds))
    const factor = 1 + (Math.random() * 2 - 1) * ratio
    return Math.max(1, Math.trunc(ttlSeconds * factor))
  }

  async get(key, options = {}) {
    const track = options.stats !== false
    const deferMiss = options.deferMiss === true
    const ttlHint = Number.isFinite(options.ttlSeconds) && options.ttlSeconds > 0
      ? options.ttlSeconds
      : (key.startsWith('m:e:') ? this.config.ttlEmbedding : this.config.ttlSearch)
    const started = performance.now()
    const l1 = this.l1Get(key)
    if (l1) {
      if (track) this.recordHit('l1', performance.now() - started)
      return { value: l1.value, level: 'l1', ageMs: Date.now() - l1.storedAt }
    }
    const l2 = this.l2Get(key)
    if (l2) {
      this.l1Set(key, l2.value, l2.expiresAt, l2.storedAt)
      if (track) this.recordHit('l2', performance.now() - started)
      return { value: l2.value, level: 'l2', ageMs: Date.now() - l2.storedAt }
    }
    if (this.l3) {
      try {
        const value = await this.l3.get(key)
        if (typeof value === 'string') {
          const ttl = Math.max(1, ttlHint)
          const expiresAt = Date.now() + ttl * 1000
          this.l1Set(key, value, expiresAt, Date.now())
          this.l2Set(key, value, expiresAt, Date.now())
          if (track) this.recordHit('l3', performance.now() - started)
          return { value, level: 'l3', ageMs: 0 }
        }
      } catch {}
    }
    if (track && !deferMiss) this.recordMiss(performance.now() - started)
    return null
  }

  set(key, value, ttlSeconds) {
    const ttl = this.jitterTtl(ttlSeconds)
    const expiresAt = Date.now() + ttl * 1000
    const storedAt = Date.now()
    this.l1Set(key, value, expiresAt, storedAt)
    this.l2Set(key, value, expiresAt, storedAt)
    if (this.l3) {
      this.l3.set(key, value, ttl).catch(() => {})
    }
  }

  delete(key) {
    this.l1.delete(key)
    const entry = this.l2.get(key)
    if (entry) {
      this.l2.delete(key)
      this.l2Bytes = Math.max(0, this.l2Bytes - Buffer.byteLength(entry.value, 'utf8'))
      this.scheduleL2Flush()
    }
    if (this.l3) this.l3.del([key]).catch(() => {})
  }

  async purge(level = 'all', scope = 'all') {
    // Purge only retrieval responses (m:s:) and negative entries (m:n:).
    // Embedding vectors (m:e:) stay reusable across purges.
    const isSearchKey = (key) => key.startsWith('m:s:') || key.startsWith('m:n:')
    let removed = 0
    const clearL1 = level === 'all' || level === 'l1'
    const clearL2 = level === 'all' || level === 'l2'
    const clearL3 = (level === 'all' || level === 'l3') && this.l3 !== null
    if (clearL1) {
      for (const key of [...this.l1.keys()]) {
        if (!isSearchKey(key)) continue
        this.l1.delete(key)
        removed += 1
      }
    }
    if (clearL2) {
      for (const [key, entry] of [...this.l2.entries()]) {
        if (!isSearchKey(key)) continue
        this.l2.delete(key)
        this.l2Bytes = Math.max(0, this.l2Bytes - Buffer.byteLength(entry.value, 'utf8'))
        removed += 1
      }
      this.scheduleL2Flush()
    }
    if (clearL3) {
      try {
        const keys = await this.l3.scan('m:s:*')
        const negative = await this.l3.scan('m:n:*')
        const all = [...keys, ...negative]
        removed += all.length
        if (all.length) await this.l3.del(all)
      } catch {}
    }
    return { removed, level, scope }
  }

  async remoteVersion(userId) {
    if (!this.l3) return null
    try {
      const value = await this.l3.get(`m:v:${userId}`)
      const parsed = Number.parseInt(value ?? '', 10)
      return Number.isFinite(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  async publishVersion(userId, version) {
    if (!this.l3) return
    try {
      await this.l3.set(`m:v:${userId}`, String(version), 0)
    } catch {}
  }

  stats(windowMs) {
    const now = Date.now()
    const window = Math.min(WINDOW_MAX_MS, Math.max(1000, windowMs || 300000))
    const cutoff = now - window
    const hits = { l1: 0, l2: 0, l3: 0 }
    let misses = 0
    const embedding = { total: 0, cached: 0, api: 0, local: 0 }
    const hitLatencies = []
    const missLatencies = []
    for (const bucket of this.buckets.values()) {
      if (bucket.start < cutoff) continue
      hits.l1 += bucket.hits.l1
      hits.l2 += bucket.hits.l2
      hits.l3 += bucket.hits.l3
      misses += bucket.misses
      embedding.cached += bucket.embedding.cached
      embedding.api += bucket.embedding.api
      embedding.local += bucket.embedding.local
      for (const sample of bucket.latencies) {
        if (sample.hit) hitLatencies.push(sample.ms)
        else missLatencies.push(sample.ms)
      }
    }
    embedding.total = embedding.cached + embedding.api + embedding.local
    const totalHits = hits.l1 + hits.l2 + hits.l3
    const totalRequests = totalHits + misses
    return {
      window_ms: window,
      hit_rate: {
        overall: totalRequests ? totalHits / totalRequests : 0,
        l1: totalRequests ? hits.l1 / totalRequests : 0,
        l2: totalRequests ? hits.l2 / totalRequests : 0,
        l3: totalRequests ? hits.l3 / totalRequests : 0,
      },
      entries: {
        l1: this.l1.size,
        l2: this.l2.size,
        l3: this.l3?.trackedKeys.size ?? 0,
      },
      latency_ms: {
        cache_hit_p95: Number(percentile(hitLatencies, 0.95).toFixed(2)),
        cache_miss_p95: Number(percentile(missLatencies, 0.95).toFixed(2)),
      },
      embedding_calls: embedding,
      evictions: { ...this.evictions },
      l3: this.l3 ? this.l3.status() : { enabled: false, connected: false },
      totals: { hits, misses, requests: totalRequests },
    }
  }
}
