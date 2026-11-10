/** Agent-facing memory tools. Each tool calls the same service methods as the Web UI. */
import { ApiError } from './service.js'
import { truncateText } from './util.js'

function text(value) {
  return [{ type: 'text', text: String(value) }]
}

function toolError(error) {
  if (error instanceof ApiError) {
    error.info = { name: 'MemoryError', code: String(error.code), reason: error.message }
  }
  return error
}

function summarizeSearch(data) {
  const lines = [
    `query: ${data.query}`,
    `results: ${data.total}  cache: ${data.cache?.hit ? data.cache.level : 'miss'}  latency: ${data.latency_ms}ms  index_version: ${data.index_version}${data.degraded ? `  degraded: ${data.degraded_reason}` : ''}`,
  ]
  data.results.forEach((item, index) => {
    const channels = Array.isArray(item.sources) ? item.sources.join('+') : 'unknown'
    const semantic = item.scores?.semantic === null ? '-' : item.scores?.semantic
    const keyword = item.scores?.keyword === null ? '-' : item.scores?.keyword
    lines.push('')
    lines.push(`${index + 1}. ${truncateText(item.content, 800)}`)
    lines.push(`   id=${item.id} session=${item.session_id} source=${item.source} channels=${channels} score=${item.score}`)
    lines.push(`   semantic=${semantic} keyword=${keyword}`)
  })
  if (data.total === 0) lines.push('', 'No matching memories. Do not invent past context.')
  return lines.join('\n')
}

function summarizeWrite(data) {
  if (data.deduplicated) {
    return `Memory already exists: id=${data.id} version=${data.version} keywords=${(data.keywords ?? []).join(', ')}`
  }
  const warning = data.warning ? ` warning=${data.warning}` : ''
  return `Saved memory: id=${data.id} version=${data.version} embed=${data.embed_status} keywords=${(data.keywords ?? []).join(', ')} index_version=${data.index_version}${warning}`
}

function summarizeManage(action, data) {
  if (action === 'list') {
    const lines = [`memories: ${data.total} next_cursor=${data.next_cursor ?? 'null'}`]
    for (const item of data.items) {
      lines.push('')
      lines.push(`${item.id}  ${truncateText(item.content, 400)}`)
      lines.push(`  session=${item.session_id} source=${item.source} version=${item.version} created=${item.created_at} keywords=${(item.keywords ?? []).join(', ')}`)
    }
    return lines.join('\n')
  }
  if (action === 'delete') return `Deleted memory ${data.id} (hard=${data.hard}, index_version=${data.index_version})`
  if (action === 'purge_cache') return `Cache purged: ${data.removed} entries removed (level=${data.level}, scope=${data.scope}, index_version=${data.index_version})`
  if (action === 'reembed') return `Re-embedding finished: scanned=${data.scanned} succeeded=${data.succeeded} failed=${data.failed} index_version=${data.index_version}`
  if (action === 'stats') {
    const cache = data.cache
    return [
      `memories: ${data.memories.active} active, ${data.memories.pending} pending embedding`,
      `cache hit rate: ${(cache.hit_rate.overall * 100).toFixed(1)}% (l1 ${(cache.hit_rate.l1 * 100).toFixed(1)}%, l2 ${(cache.hit_rate.l2 * 100).toFixed(1)}%, l3 ${(cache.hit_rate.l3 * 100).toFixed(1)}%)`,
      `entries: l1=${cache.entries.l1} l2=${cache.entries.l2} l3=${cache.entries.l3}`,
      `latency p95: hit=${cache.latency_ms.cache_hit_p95}ms miss=${cache.latency_ms.cache_miss_p95}ms`,
      `embedding: mode=${data.embedding.mode} state=${data.embedding.state} dim=${data.embedding.dim}`,
      `index_version: ${data.index_version}`,
    ].join('\n')
  }
  if (action === 'get' || action === 'update') {
    return `${action}: id=${data.id} version=${data.version} embed=${data.embed_status} updated=${data.updated_at}\n${truncateText(data.content, 1200)}`
  }
  return JSON.stringify(data, null, 2)
}

export function createTools(service) {
  const searchTool = {
    name: 'memory_search',
    description: [
      'Search the user\'s persistent cross-session memory using hybrid semantic + keyword recall (RRF fusion).',
      'Call this before answering questions that depend on earlier sessions, user preferences, project decisions, or facts the user expects you to remember.',
      'Results include the memory content, source channel(s), semantic/keyword scores, session, and timestamp.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to recall. Natural language is fine; boolean operators AND/OR/NOT and "quoted phrases" are also accepted.' },
        topk: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum memories to return (default 8).' },
        scope: { type: 'string', enum: ['session', 'user', 'global'], description: 'session = current conversation; user = all conversations (default); global = the user\'s shared memory.' },
        session_id: { type: 'string', description: 'Required when scope=session; defaults to the current session.' },
        min_score: { type: 'number', minimum: 0, maximum: 1, description: 'Minimum semantic similarity for semantic hits (default 0).' },
        filters: {
          type: 'object',
          description: 'Optional metadata filters.',
          properties: {
            session_ids: { type: 'array', items: { type: 'string' } },
            sources: { type: 'array', items: { type: 'string' } },
            time_range: {
              type: 'object',
              properties: { from: { type: 'string' }, to: { type: 'string' } },
            },
          },
        },
      },
      required: ['query'],
    },
    output: {
      schema: { type: 'object', description: 'Hybrid search response with fused results and cache metadata.' },
      render(_args, value) {
        return text(summarizeSearch(value))
      },
    },
    isConcurrencySafe() {
      return true
    },
    async execute(args, exec) {
      try {
        const input = { ...args }
        if (!input.session_id && exec?.agent?.id) input.session_id = String(exec.agent.id)
        if (input.topk === undefined) input.topk = 8
        input.use_cache = true
        return await service.search(input)
      } catch (error) {
        throw toolError(error)
      }
    },
  }

  const writeTool = {
    name: 'memory_write',
    description: [
      'Save one durable memory for the user across sessions. Use it for stable preferences, profile facts, decisions, project constraints, and instructions the user expects you to remember.',
      'Do not save transient chatter, secrets, credentials, or content the user asked you to forget. Keep each memory concise and self-contained; the service masks phone numbers, emails, IDs, and API keys before storing.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The memory text, self-contained, at most 8000 characters.' },
        session_id: { type: 'string', description: 'Conversation this memory came from; defaults to the current session.' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'Optional explicit keywords (max 20, 32 chars each).' },
        source: { type: 'string', description: 'Source label, default "chat".' },
        ttl_seconds: { type: 'integer', minimum: 60, maximum: 31536000, description: 'Optional memory-level TTL in seconds; omit for permanent.' },
        need_embedding: { type: 'boolean', description: 'Generate a vector (default true).' },
        need_keywords: { type: 'boolean', description: 'Auto-extract keywords (default true).' },
      },
      required: ['content'],
    },
    output: {
      schema: { type: 'object', description: 'Write result with id, version, embedding status, keywords, and index version.' },
      render(_args, value) {
        return text(summarizeWrite(value))
      },
    },
    isConcurrencySafe() {
      return false
    },
    async execute(args, exec) {
      try {
        const input = { ...args }
        if (!input.session_id && exec?.agent?.id) input.session_id = String(exec.agent.id)
        return await service.write(input)
      } catch (error) {
        throw toolError(error)
      }
    },
  }

  const manageTool = {
    name: 'memory_manage',
    description: [
      'Manage the user\'s persisted memories and inspect the memory cache.',
      'Actions: list (page through memories), get (read one), update (content/keywords/extra/ttl), delete (soft by default), stats (cache hit rate, entries, latency, embedding state), purge_cache, reembed (retry pending vectors; force=true re-embeds every active memory after switching embedding models).',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'update', 'delete', 'stats', 'purge_cache', 'reembed'],
          description: 'Operation to perform.',
        },
        id: { type: 'string', description: 'Memory id for get/update/delete.' },
        session_id: { type: 'string', description: 'Session filter for list; defaults to all sessions.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Page size for list (default 20).' },
        cursor: { type: 'string', description: 'Opaque cursor from a previous list call.' },
        content: { type: 'string', description: 'New content for update.' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'Replacement keywords for update.' },
        extra: { type: 'object', description: 'Replacement metadata for update (max 4KB).' },
        version: { type: 'integer', description: 'Optimistic-lock version for update; omit to force.' },
        ttl_seconds: { type: 'integer', minimum: 60, maximum: 31536000, description: 'Memory TTL for update.' },
        hard: { type: 'boolean', description: 'Permanently delete (requires allowHardDelete configuration).' },
        level: { type: 'string', enum: ['all', 'l1', 'l2', 'l3'], description: 'Cache level for purge_cache.' },
        scope: { type: 'string', enum: ['all', 'user'], description: 'Cache purge scope.' },
        window: { type: 'string', description: 'Stats window such as 300s, 5m, 1h.' },
        force: { type: 'boolean', description: 'For reembed: re-embed every active memory, including those already marked ok. Use after switching embedding models.' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', description: 'Operation-specific management result.' },
      render(args, value) {
        return text(summarizeManage(args.action, value))
      },
    },
    isConcurrencySafe(args) {
      return args?.action === 'list' || args?.action === 'get' || args?.action === 'stats'
    },
    async execute(args, exec) {
      try {
        switch (args.action) {
          case 'list':
            return await service.list({
              session_id: args.session_id,
              limit: args.limit,
              cursor: args.cursor,
            })
          case 'get':
            if (!args.id) throw new ApiError(400, 40001, 'id is required for get')
            return await service.get(args.id, { includeEmbedding: false })
          case 'update': {
            if (!args.id) throw new ApiError(400, 40001, 'id is required for update')
            const patch = {}
            if (args.content !== undefined) patch.content = args.content
            if (args.keywords !== undefined) patch.keywords = args.keywords
            if (args.extra !== undefined) patch.extra = args.extra
            if (args.ttl_seconds !== undefined) patch.ttl_seconds = args.ttl_seconds
            if (args.version !== undefined) patch.version = args.version
            return await service.update(args.id, patch)
          }
          case 'delete':
            if (!args.id) throw new ApiError(400, 40001, 'id is required for delete')
            return await service.remove(args.id, { hard: Boolean(args.hard) })
          case 'stats':
            return await service.stats({ window: args.window })
          case 'purge_cache':
            return await service.purgeCache({ level: args.level, scope: args.scope })
          case 'reembed':
            return await service.reembed({ force: Boolean(args.force) })
          default:
            throw new ApiError(400, 40001, `unknown action: ${args.action}`)
        }
      } catch (error) {
        throw toolError(error)
      }
    },
  }

  return [searchTool, writeTool, manageTool]
}
