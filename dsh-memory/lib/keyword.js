/** In-memory BM25 keyword index with jieba-style application-layer tokenization. */
import { normalizeText, tokenize } from './util.js'

const BM25_K1 = 1.2
const BM25_B = 0.75

function setIntersect(left, right) {
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]
  const result = new Set()
  for (const value of small) if (large.has(value)) result.add(value)
  return result
}

function setUnion(left, right) {
  const result = new Set(left)
  for (const value of right) result.add(value)
  return result
}

function setDifference(left, right) {
  const result = new Set()
  for (const value of left) if (!right.has(value)) result.add(value)
  return result
}

function clauseTokens(text) {
  return tokenize(text)
}

/**
 * Parse the small boolean dialect used by the keyword channel:
 * `AND` / `OR` / `NOT` (or `&&` / `||` / `!`), leading `-` negation, and
 * "quoted phrases". Natural-language input defaults to OR.
 */
export function parseKeywordQuery(input) {
  const text = normalizeText(input)
  const clauses = []
  const pattern = /"([^"]*)"|(\S+)/g
  let nextConnector = 'OR'
  let pendingNegate = false
  const addTermClauses = (value, negate, connector) => {
    const tokens = tokenize(value)
    const terms = tokens.length ? tokens : [value.toLowerCase()]
    for (const term of terms) {
      clauses.push({ kind: 'term', value: term, negate, connector })
    }
  }
  for (const match of text.matchAll(pattern)) {
    const phrase = match[1]
    const raw = match[2]
    if (phrase !== undefined) {
      const normalized = phrase.trim().toLowerCase()
      if (normalized) clauses.push({ kind: 'phrase', value: normalized, negate: pendingNegate, connector: nextConnector })
      pendingNegate = false
      nextConnector = 'OR'
      continue
    }
    if (!raw) continue
    const upper = raw.toUpperCase()
    if (upper === 'AND' || upper === '&&') {
      nextConnector = 'AND'
      continue
    }
    if (upper === 'OR' || upper === '||') {
      nextConnector = 'OR'
      continue
    }
    if (upper === 'NOT' || raw === '!') {
      pendingNegate = true
      continue
    }
    let value = raw
    let negate = pendingNegate
    if (raw.startsWith('-') && raw.length > 1) {
      value = raw.slice(1)
      negate = true
    } else if (raw.startsWith('!') && raw.length > 1) {
      value = raw.slice(1)
      negate = true
    }
    if (value) addTermClauses(value, negate, nextConnector)
    pendingNegate = false
    nextConnector = 'OR'
  }
  return clauses
}

export class KeywordIndex {
  constructor() {
    this.documents = new Map()
    this.postings = new Map()
    this.documentFrequency = new Map()
    this.totalLength = 0
  }

  get size() {
    return this.documents.size
  }

  clear() {
    this.documents.clear()
    this.postings.clear()
    this.documentFrequency.clear()
    this.totalLength = 0
  }

  add(record) {
    this.remove(record.id)
    const contentTokens = tokenize(record.content)
    const keywordTokens = tokenize(Array.isArray(record.keywords) ? record.keywords.join(' ') : '')
    const terms = new Map()
    for (const token of contentTokens) terms.set(token, (terms.get(token) ?? 0) + 1)
    // The keywords field carries twice the weight of the body (tech plan §5.2).
    for (const token of keywordTokens) terms.set(token, (terms.get(token) ?? 0) + 2)
    if (terms.size === 0) return
    let length = 0
    for (const value of terms.values()) length += value
    const document = {
      id: record.id,
      terms,
      length,
      content: normalizeText(record.content).toLowerCase(),
      meta: {
        userId: record.userId,
        sessionId: record.sessionId,
        source: record.source,
        createdAt: record.createdAt,
      },
    }
    this.documents.set(record.id, document)
    this.totalLength += length
    for (const [term, frequency] of terms) {
      let posting = this.postings.get(term)
      if (!posting) {
        posting = new Map()
        this.postings.set(term, posting)
      }
      posting.set(record.id, frequency)
      this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1)
    }
  }

  remove(id) {
    const document = this.documents.get(id)
    if (!document) return false
    this.documents.delete(id)
    this.totalLength -= document.length
    for (const term of document.terms.keys()) {
      const posting = this.postings.get(term)
      if (!posting) continue
      posting.delete(id)
      const frequency = (this.documentFrequency.get(term) ?? 1) - 1
      if (frequency <= 0) {
        this.documentFrequency.delete(term)
        this.postings.delete(term)
      } else {
        this.documentFrequency.set(term, frequency)
      }
      if (posting.size === 0) this.postings.delete(term)
    }
    return true
  }

  idsForClause(clause) {
    if (clause.kind === 'phrase') {
      const phrase = clause.value
      if (!phrase) return new Set()
      const ids = new Set()
      for (const document of this.documents.values()) {
        if (document.content.includes(phrase)) ids.add(document.id)
      }
      return ids
    }
    const posting = this.postings.get(clause.value)
    return posting ? new Set(posting.keys()) : new Set()
  }

  /**
   * @param {string} input
   * @param {(recordId: string, meta: object) => boolean} allow filter callback
   * @param {number} candidateK
   */
  search(input, allow, candidateK) {
    const clauses = parseKeywordQuery(input)
    if (clauses.length === 0) return []
    const allIds = new Set(this.documents.keys())
    let candidates = null
    for (const clause of clauses) {
      if (clause.negate) {
        const excluded = this.idsForClause(clause)
        if (candidates === null) candidates = setDifference(allIds, excluded)
        else candidates = setDifference(candidates, excluded)
        continue
      }
      const ids = this.idsForClause(clause)
      if (candidates === null) {
        candidates = new Set(ids)
      } else if (clause.connector === 'AND') {
        candidates = setIntersect(candidates, ids)
      } else {
        candidates = setUnion(candidates, ids)
      }
    }
    if (candidates === null || candidates.size === 0) return []

    const positive = clauses.filter((clause) => !clause.negate)
    const termClauses = positive.filter((clause) => clause.kind === 'term')
    const phraseClauses = positive.filter((clause) => clause.kind === 'phrase')
    const documentCount = this.documents.size
    const averageLength = documentCount > 0 ? this.totalLength / documentCount : 1
    const scored = []

    for (const id of candidates) {
      const document = this.documents.get(id)
      if (!document) continue
      if (typeof allow === 'function' && !allow(id, document.meta)) continue
      let score = 0
      for (const clause of termClauses) {
        const frequency = document.terms.get(clause.value)
        if (!frequency) continue
        const df = this.documentFrequency.get(clause.value) ?? 1
        const idf = Math.log(1 + (documentCount - df + 0.5) / (df + 0.5))
        const denominator = frequency + BM25_K1 * (1 - BM25_B + BM25_B * (document.length / Math.max(1, averageLength)))
        score += idf * ((frequency * (BM25_K1 + 1)) / denominator)
      }
      for (const clause of phraseClauses) {
        if (!document.content.includes(clause.value)) continue
        const phraseTokens = clauseTokens(clause.value)
        let phraseScore = 1.5
        for (const token of new Set(phraseTokens)) {
          const frequency = document.terms.get(token)
          if (!frequency) continue
          const df = this.documentFrequency.get(token) ?? 1
          const idf = Math.log(1 + (documentCount - df + 0.5) / (df + 0.5))
          phraseScore += idf * Math.min(frequency, 3)
        }
        score += phraseScore
      }
      if (score > 0) scored.push({ id, raw: score })
    }
    if (scored.length === 0) return []
    scored.sort((left, right) => right.raw - left.raw)
    const limited = scored.slice(0, Math.max(1, candidateK))
    const max = limited[0]?.raw || 1
    return limited.map((item, index) => ({
      id: item.id,
      raw: item.raw,
      score: Math.min(1, item.raw / max),
      rank: index + 1,
    }))
  }
}
