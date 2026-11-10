/** Pure helpers shared by the memory plugin. No host or storage dependencies. */
import { createHash, randomUUID } from 'node:crypto'

export const BUILD = '2026-11-10.5'

export function nowIso() {
  return new Date().toISOString()
}

export function uuid() {
  return randomUUID()
}

export function sha1(value) {
  return createHash('sha1').update(String(value)).digest('hex')
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

export function asInt(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  let next = Math.trunc(parsed)
  if (typeof min === 'number') next = Math.max(min, next)
  if (typeof max === 'number') next = Math.min(max, next)
  return next
}

export function asFloat(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  if (!Number.isFinite(parsed)) return fallback
  let next = parsed
  if (typeof min === 'number') next = Math.max(min, next)
  if (typeof max === 'number') next = Math.min(max, next)
  return next
}

export function asBool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 1 || value === '1') return true
  if (value === 'false' || value === 0 || value === '0') return false
  return fallback
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  }
  if (typeof value === 'undefined') return 'null'
  return JSON.stringify(value)
}

export function stableStringify(value) {
  return stable(value)
}

export function hashFilters(value) {
  return sha256(stable(value ?? {}))
}

/** NFKC, strip control characters, collapse whitespace. */
export function normalizeText(input) {
  if (typeof input !== 'string') return ''
  let text = input.normalize('NFKC')
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
  text = text.replace(/[ \t\f\v]+/g, ' ')
  text = text.replace(/\s*\n\s*/g, '\n')
  return text.trim()
}

/** Query normalization: case-folded, single-line, bounded to 512 chars. */
export function normalizeQuery(input) {
  return normalizeText(input)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 512)
    .trim()
}

const PLACEHOLDER = {
  secret: '[SECRET]',
  email: '[EMAIL]',
  id: '[ID]',
  phone: '[PHONE]',
  card: '[CARD]',
}

function maskCards(text) {
  return text.replace(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g, (match) => {
    const digits = match.replace(/\D/g, '')
    if (digits.length < 13 || digits.length > 19) return match
    if (!luhn(digits)) return match
    return PLACEHOLDER.card
  })
}

function luhn(digits) {
  let sum = 0
  let double = false
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index])
    if (double) {
      value *= 2
      if (value > 9) value -= 9
    }
    sum += value
    double = !double
  }
  return sum % 10 === 0
}

/**
 * Mask personally identifying and credential-like content before it is stored
 * or embedded. The masked form is what the memory keeps.
 */
export function maskPII(input) {
  let text = String(input ?? '')
  text = text.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, PLACEHOLDER.secret)
  text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, PLACEHOLDER.secret)
  text = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, PLACEHOLDER.email)
  text = text.replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, PLACEHOLDER.id)
  text = text.replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, PLACEHOLDER.phone)
  text = maskCards(text)
  return text
}

const CJK_RE = /[\u3400-\u9fff]/
const WORD_RE = /[A-Za-z][A-Za-z0-9_+#./-]*|\d+(?:\.\d+)*|[\u3400-\u9fff]+/g

const STOPWORDS = new Set([
  // Chinese function words
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '我们', '你们', '他们', '这', '那', '这个', '那个',
  '一个', '什么', '怎么', '如何', '为什么', '可以', '需要', '使用', '进行', '以及', '和', '与', '及', '或',
  '但', '但是', '因为', '所以', '如果', '就', '都', '也', '还', '有', '没有', '会', '能', '要', '把', '被',
  '让', '给', '对', '从', '到', '中', '上', '下', '里', '后', '前', '时', '时候', '之', '其', '而', '并',
  '等', '着', '过', '吧', '呢', '吗', '啊', '呀', '哦', '嗯', '想', '请', '好', '地', '得', '很', '更',
  '最', '不', '没', '无', '非', '已经', '正在', '用于', '通过', '关于', '之前', '之后', '哪个', '哪些',
  '多少', '几', '是否', '能否', '可否', '一下', '一些', '这些', '那些', '这里', '那里', '其中', '的话',
  '又', '再', '才', '只', '将', '对于', '作为', '由于', '因此', '然后', '而且', '或者', '不过', '虽然',
  '只是', '可能', '应该', '必须', '能够', '实现', '支持', '提供', '包括', '例如', '比如', '等等',
  'email', 'phone', 'id', 'card', 'secret', 'redacted', 'unavailable', 'disabled',
  // English function words
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'of', 'to', 'in', 'on', 'at', 'for',
  'with', 'without', 'from', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'this',
  'that', 'these', 'those', 'it', 'its', 'i', 'you', 'he', 'she', 'we', 'they', 'them', 'my', 'your',
  'our', 'their', 'what', 'which', 'who', 'whom', 'how', 'why', 'when', 'where', 'can', 'could',
  'should', 'would', 'may', 'might', 'must', 'will', 'shall', 'do', 'does', 'did', 'not', 'no', 'yes',
  'use', 'using', 'used', 'user', 'users', 'want', 'wants', 'need', 'needs', 'have', 'has', 'had',
  'got', 'get', 'make', 'made', 'just', 'also', 'more', 'most', 'very', 'much', 'many', 'some', 'any',
  'all', 'each', 'every', 'other', 'into', 'about', 'over', 'under', 'between', 'after', 'before',
  'during', 'while', 'because', 'so', 'than', 'too', 'only', 'own', 'same', 'such', 'both', 'few', 'etc',
])

const segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('zh', { granularity: 'word' })
  : null

function cleanToken(raw) {
  const token = raw.normalize('NFKC').toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
  if (!token) return ''
  if (STOPWORDS.has(token)) return ''
  if (token.length === 1 && CJK_RE.test(token)) return token
  if (token.length < 2 && !/^\d+$/.test(token)) return ''
  return token
}

/** Word tokens for Chinese and Latin text. Falls back to bigrams without Intl.Segmenter. */
export function tokenize(input) {
  const text = normalizeText(input)
  if (!text) return []
  const tokens = []
  if (segmenter) {
    // ICU word segmentation falls back to single characters for unknown
    // compounds. Merge adjacent single CJK characters into bigrams so
    // "云端记忆插件" yields useful terms instead of one-character keys.
    // A separator, stopword, or multi-character word flushes the run.
    let singles = ''
    const flushSingles = () => {
      if (!singles) return
      if (singles.length === 1) tokens.push(singles)
      else for (let index = 0; index < singles.length - 1; index += 1) tokens.push(singles.slice(index, index + 2))
      singles = ''
    }
    for (const part of segmenter.segment(text)) {
      if (!part.isWordLike) {
        flushSingles()
        continue
      }
      const token = cleanToken(part.segment)
      if (!token) {
        flushSingles()
        continue
      }
      if (CJK_RE.test(token) && token.length === 1) {
        singles += token
        continue
      }
      flushSingles()
      tokens.push(token)
    }
    flushSingles()
    if (tokens.length > 0) return tokens
  }
  for (const match of text.matchAll(WORD_RE)) {
    const raw = match[0]
    if (CJK_RE.test(raw)) {
      if (raw.length === 1) {
        const token = cleanToken(raw)
        if (token) tokens.push(token)
      } else {
        for (let index = 0; index < raw.length - 1; index += 1) {
          const token = cleanToken(raw.slice(index, index + 2))
          if (token) tokens.push(token)
        }
      }
    } else {
      const token = cleanToken(raw)
      if (token) tokens.push(token)
    }
  }
  return tokens
}

/** Extract up to `limit` representative keywords, preserving first-seen order for ties. */
export function extractKeywords(input, limit = 8) {
  const tokens = tokenize(input)
  const counts = new Map()
  const order = new Map()
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1)
    if (!order.has(token)) order.set(token, order.size)
  }
  const ranked = [...counts.entries()]
    .filter(([token]) => !(CJK_RE.test(token) && token.length === 1))
    .map(([token, count]) => ({
      token,
      score: Math.log(1 + count) * (1 + Math.min(token.length, 8) * 0.08),
      order: order.get(token) ?? 0,
    }))
    .sort((left, right) => right.score - left.score || left.order - right.order)
  return ranked.slice(0, limit).map((item) => item.token)
}

export function encodeVector(vector) {
  const values = Float32Array.from(vector)
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString('base64')
}

export function decodeVector(encoded) {
  if (typeof encoded !== 'string' || encoded.length === 0) return null
  const buffer = Buffer.from(encoded, 'base64')
  if (buffer.byteLength % 4 !== 0) return null
  const copy = Buffer.from(buffer)
  const values = new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4)
  return Float32Array.from(values)
}

export function l2Normalize(vector) {
  let sum = 0
  for (const value of vector) sum += value * value
  const norm = Math.sqrt(sum)
  if (!Number.isFinite(norm) || norm === 0) return vector
  for (let index = 0; index < vector.length; index += 1) vector[index] /= norm
  return vector
}

function fnv1a(text, seed) {
  let hash = (0x811c9dc5 ^ seed) >>> 0
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * Deterministic 1024-dimension hashing vectorizer. It is a lexical fallback,
 * not a semantic model: it lets the plugin work without a BGE-M3 endpoint.
 */
export function localEmbed(input, dim = 1024) {
  const vector = new Float32Array(dim)
  const tokens = tokenize(input)
  const counts = new Map()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  for (const [token, count] of counts) {
    const weight = 1 + Math.log(1 + count)
    const primary = fnv1a(token, 0x9e3779b9)
    const secondary = fnv1a(token, 0x85ebca6b)
    const sign = (secondary & 1) === 0 ? 1 : -1
    vector[primary % dim] += sign * weight
    vector[(primary >>> 11) % dim] += sign * weight * 0.5
    if (CJK_RE.test(token) && token.length >= 2) {
      for (let index = 0; index < token.length - 1; index += 1) {
        const bigram = token.slice(index, index + 2)
        const hash = fnv1a(bigram, 0xc2b2ae35)
        vector[hash % dim] += sign * weight * 0.4
      }
    }
  }
  return l2Normalize(vector)
}

export function cosine(left, right) {
  const length = Math.min(left.length, right.length)
  let dot = 0
  for (let index = 0; index < length; index += 1) dot += left[index] * right[index]
  return clamp(dot, -1, 1)
}

export function parseTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string' || value.length === 0) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function toIso(value) {
  const parsed = parseTime(value)
  return parsed === null ? null : new Date(parsed).toISOString()
}

export function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer?.unref === 'function') timer.unref()
  })
}

export function percentile(values, ratio) {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index]
}

export function truncateText(text, max = 120) {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`
}
