/** REST surface used by the Web panel and by external HTTP callers. */
import { asBool, asInt, nowIso, sha256, stableStringify, uuid } from './util.js'
import { ApiError } from './service.js'

export const API_PREFIX = '/dsh-memory/api'

function requestIdOf(request) {
  const header = request.headers.get('x-request-id')
  if (header && header.length <= 128) return header
  return `req_${uuid().slice(0, 8)}`
}

function respond(data, status, requestId) {
  return new Response(JSON.stringify({ code: 0, message: 'ok', data, request_id: requestId }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-request-id': requestId,
    },
  })
}

function respondError(error, status, requestId) {
  const code = error instanceof ApiError ? error.code : 50000
  const message = error instanceof Error ? error.message : String(error)
  return new Response(JSON.stringify({ code, message, data: null, request_id: requestId }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-request-id': requestId,
    },
  })
}

async function readJson(request) {
  const length = Number(request.headers.get('content-length') ?? 0)
  if (Number.isFinite(length) && length > 2 * 1024 * 1024) {
    throw new ApiError(413, 40001, 'request body is too large')
  }
  const text = await request.text()
  if (!text) return {}
  if (text.length > 2 * 1024 * 1024) throw new ApiError(413, 40001, 'request body is too large')
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ApiError(400, 40001, 'request body must be a JSON object')
    }
    return parsed
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(400, 40001, 'request body is not valid JSON')
  }
}

function idempotencyHeader(request) {
  const value = request.headers.get('idempotency-key')
  if (!value) return null
  const key = value.trim()
  if (!key || key.length > 128) throw new ApiError(400, 40001, 'Idempotency-Key must be 1-128 characters')
  return key
}

async function withIdempotency(service, request, body, operation, options = {}) {
  const statusOf = typeof options.statusOf === 'function'
    ? options.statusOf
    : () => (Number.isFinite(options.successStatus) ? options.successStatus : 200)
  const key = idempotencyHeader(request)
  if (!key) {
    const data = await operation()
    return { replayed: false, status: statusOf(data), data }
  }
  const bodyHash = sha256(stableStringify(body))
  const existing = service.store.getIdempotency(key)
  if (existing) {
    if (existing.bodyHash !== bodyHash) throw new ApiError(409, 40902, 'Idempotency-Key was reused with a different request body')
    const created = Date.parse(existing.createdAt)
    if (!Number.isFinite(created) || Date.now() - created < 24 * 3600 * 1000) {
      return { replayed: true, status: existing.status ?? 200, data: existing.response }
    }
  }
  const result = await operation()
  const status = statusOf(result)
  await service.store.putIdempotency(key, {
    key,
    bodyHash,
    status,
    response: result,
    createdAt: nowIso(),
  })
  return { replayed: false, status, data: result }
}

function splitPath(path) {
  return path.split('/').filter(Boolean).map((part) => decodeURIComponent(part))
}

function isLoopback(address) {
  if (!address) return true
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
    || address.startsWith('127.')
}

function readNodeBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 2 * 1024 * 1024) {
        req.destroy()
        reject(new ApiError(413, 40001, 'request body is too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function writeNodeResponse(res, response, headOnly) {
  res.statusCode = response.status
  response.headers.forEach((value, key) => {
    res.setHeader(key, value)
  })
  return response.arrayBuffer().then((buffer) => {
    res.end(headOnly ? undefined : Buffer.from(buffer))
  })
}

export function createHttpHandler(service) {
  async function dispatch(request, url) {
    const method = request.method.toUpperCase()
    const path = url.pathname.slice(API_PREFIX.length) || '/'
    const parts = splitPath(path)

    if (method === 'GET' && (path === '/' || path === '')) {
      return { status: 200, data: {
        name: 'dsh-memory',
        version: 1,
        endpoints: [
          'GET /health', 'GET /stats', 'GET /search?q=', 'POST /search',
          'POST /memories', 'POST /memories:batch', 'GET /memories', 'GET /memories/{id}',
          'PUT /memories/{id}', 'DELETE /memories/{id}', 'GET /cache/stats',
          'POST /cache/purge', 'POST /memories:reembed', 'GET /config',
        ],
      } }
    }
    if (method === 'GET' && path === '/health') {
      return { status: 200, data: await service.health({ user_id: url.searchParams.get('user_id') ?? undefined }) }
    }
    if (method === 'GET' && (path === '/stats' || path === '/cache/stats')) {
      return {
        status: 200,
        data: await service.stats({
          user_id: url.searchParams.get('user_id') ?? undefined,
          window: url.searchParams.get('window') ?? undefined,
        }),
      }
    }
    if (method === 'GET' && path === '/config') {
      return { status: 200, data: {
        user_id: service.config.userId,
        embedding: service.embedder.info(),
        retrieval: { ...service.config.retrieval },
        cache: {
          ttl_search_s: service.config.cache.ttlSearch,
          ttl_embedding_s: service.config.cache.ttlEmbedding,
          ttl_negative_s: service.config.cache.ttlNegative,
          l1_max_entries: service.config.cache.l1MaxEntries,
          l2_max_entries: service.config.cache.l2MaxEntries,
          l3_enabled: Boolean(service.config.cache.l3Url),
        },
        security: { ...service.config.security },
      } }
    }
    if (method === 'GET' && path === '/search') {
      const query = url.searchParams.get('q') ?? url.searchParams.get('query')
      const topk = url.searchParams.get('topk')
      const scope = url.searchParams.get('scope')
      const sessionId = url.searchParams.get('session_id')
      return {
        status: 200,
        data: await service.search({
          query,
          topk: topk === null ? undefined : asInt(topk, 10, 1, 50),
          scope: scope ?? undefined,
          session_id: sessionId ?? undefined,
          use_cache: url.searchParams.get('use_cache') === null ? undefined : url.searchParams.get('use_cache'),
        }),
      }
    }
    if (method === 'POST' && path === '/search') {
      const body = await readJson(request)
      return { status: 200, data: await service.search(body) }
    }
    if (method === 'POST' && path === '/memories') {
      const body = await readJson(request)
      const result = await withIdempotency(service, request, body, () => service.write(body), {
        statusOf: (data) => (data?.deduplicated ? 200 : 201),
      })
      return { status: result.status, data: result.data }
    }
    if (method === 'POST' && path === '/memories:batch') {
      const body = await readJson(request)
      const result = await withIdempotency(service, request, body, () => service.batchWrite(body), {
        successStatus: 200,
      })
      return { status: result.status, data: result.data }
    }
    if (method === 'POST' && path === '/memories:reembed') {
      const body = await readJson(request)
      return { status: 200, data: await service.reembed(body) }
    }
    if (method === 'GET' && path === '/memories') {
      return {
        status: 200,
        data: await service.list({
          user_id: url.searchParams.get('user_id') ?? undefined,
          session_id: url.searchParams.get('session_id') ?? undefined,
          limit: url.searchParams.get('limit') ?? undefined,
          cursor: url.searchParams.get('cursor') ?? undefined,
          include_deleted: url.searchParams.get('include_deleted') ?? undefined,
        }),
      }
    }
    if (parts[0] === 'memories' && parts.length === 2) {
      const id = parts[1]
      if (method === 'GET') {
        return {
          status: 200,
          data: await service.get(id, {
            includeDeleted: asBool(url.searchParams.get('include_deleted'), false),
            includeEmbedding: asBool(url.searchParams.get('include_embedding'), false),
          }),
        }
      }
      if (method === 'PUT') {
        const body = await readJson(request)
        return { status: 200, data: await service.update(id, body) }
      }
      if (method === 'DELETE') {
        return {
          status: 200,
          data: await service.remove(id, { hard: asBool(url.searchParams.get('hard'), false) }),
        }
      }
    }
    if (method === 'POST' && path === '/cache/purge') {
      const body = await readJson(request)
      return { status: 200, data: await service.purgeCache(body) }
    }
    throw new ApiError(404, 40401, `no route for ${method} ${path}`)
  }

  return async function memoryResource(request, peer) {
    const requestId = requestIdOf(request)
    try {
      if (peer && peer.principal && peer.principal.kind !== 'owner') {
        throw new ApiError(403, 40301, 'memory API is available to the owner connection only')
      }
      const url = new URL(request.url, 'http://localhost')
      if (!url.pathname.startsWith(API_PREFIX)) {
        return respondError(new ApiError(404, 40401, 'not found'), 404, requestId)
      }
      const result = await dispatch(request, url)
      return respond(result.data, result.status ?? 200, requestId)
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500
      if (status >= 500) {
        service.logger?.error?.(`[memory] ${request.method} ${request.url} failed: ${error?.stack ?? error}`)
      }
      return respondError(error, status, requestId)
    }
  }
}

/**
 * Node HTTP handler for `ctx.webServer` handler routes. Resource routes only
 * answer GET/HEAD over HTTP; the panel needs POST/PUT/DELETE, so this adapter
 * rebuilds a Fetch Request and reuses the same dispatch.
 */
export function createNodeHandler(service) {
  const resource = createHttpHandler(service)
  return async function memoryNodeHandler(req, res) {
    const requestId = `req_${uuid().slice(0, 8)}`
    try {
      if (!isLoopback(req.socket?.remoteAddress)) {
        throw new ApiError(403, 40301, 'memory API is available to local connections only')
      }
      const origin = `http://${req.headers.host || '127.0.0.1'}`
      const url = new URL(req.url || '/', origin)
      const method = (req.method || 'GET').toUpperCase()
      const requestOrigin = req.headers.origin
      if (requestOrigin && requestOrigin !== origin && requestOrigin !== origin.replace('http://', 'https://')) {
        throw new ApiError(403, 40301, 'cross-origin memory writes are not allowed')
      }
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        const contentType = String(req.headers['content-type'] || '').toLowerCase()
        if (!contentType.startsWith('application/json')) {
          throw new ApiError(400, 40001, 'content-type must be application/json')
        }
      }
      const nodeHeaders = new Headers()
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') nodeHeaders.set(key, value)
        else if (Array.isArray(value)) nodeHeaders.set(key, value.join(', '))
      }
      let body
      if (method !== 'GET' && method !== 'HEAD') body = await readNodeBody(req)
      const request = new Request(url, {
        method,
        headers: nodeHeaders,
        body: body && body.length > 0 ? body : undefined,
      })
      const response = await resource(request, undefined)
      await writeNodeResponse(res, response, method === 'HEAD')
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500
      if (status >= 500) {
        service.logger?.error?.(`[memory] node handler failed: ${error?.stack ?? error}`)
      }
      const response = respondError(error, status, requestId)
      await writeNodeResponse(res, response, false)
    }
  }
}
