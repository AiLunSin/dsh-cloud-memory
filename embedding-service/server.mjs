/**
 * Local BGE-M3 embedding endpoint for dsh-memory validation.
 *
 * Downloads the quantized ONNX BGE-M3 model from the Hugging Face mirror on
 * first start, then serves:
 *   GET  /health
 *   POST /embed  { "inputs": ["text", ...] } -> { "embeddings": [[...], ...] }
 *
 * The dsh-memory plugin can use it as:
 *   embedding.provider: tei
 *   embedding.baseUrl: http://127.0.0.1:8090
 *   embedding.dim: 1024
 */
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { env, pipeline } from '@xenova/transformers'

const here = path.dirname(fileURLToPath(import.meta.url))
env.remoteHost = 'https://hf-mirror.com'
env.remotePathTemplate = '{model}/resolve/{revision}/'
env.cacheDir = path.join(here, '.cache')
env.localModelPath = path.join(here, '.cache')
env.allowLocalModels = true
// The model is downloaded once from ModelScope by download-model.mjs; loading
// it locally avoids HF's LFS CDN, which is blocked in this environment.
env.allowRemoteModels = false
env.useBrowserCache = false

const MODEL = process.env.BGE_M3_MODEL || 'Xenova/bge-m3'
const PORT = Number(process.env.EMBEDDING_PORT || 8090)
const HOST = process.env.EMBEDDING_HOST || '127.0.0.1'
const MAX_BATCH = 32
const MAX_CHARS = 8000

let extractor = null
let state = 'loading'
let loadError = null
let loadStarted = Date.now()
let loadMs = null
let embedCalls = 0
let embedTexts = 0
let lastLatencyMs = null

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 2 * 1024 * 1024) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  return JSON.parse(text)
}

function normalizeInputs(body) {
  const raw = body.inputs ?? body.input ?? body.texts ?? body.text
  const inputs = Array.isArray(raw) ? raw : [raw]
  if (!inputs.length || inputs.length > MAX_BATCH) throw new Error(`inputs must contain 1-${MAX_BATCH} strings`)
  return inputs.map((value) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('each input must be a non-empty string')
    return value.slice(0, MAX_CHARS)
  })
}

async function embed(texts) {
  const started = performance.now()
  const output = await extractor(texts, { pooling: 'cls', normalize: true })
  const dims = output.dims
  const dim = dims[dims.length - 1]
  const data = output.data
  const vectors = []
  for (let row = 0; row < texts.length; row += 1) {
    vectors.push(Array.from(data.slice(row * dim, (row + 1) * dim)))
  }
  embedCalls += 1
  embedTexts += texts.length
  lastLatencyMs = Number((performance.now() - started).toFixed(1))
  return { vectors, dim, latencyMs: lastLatencyMs }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`)
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json(res, 200, {
        ok: state === 'ready',
        state,
        model: MODEL,
        dim: 1024,
        host: HOST,
        port: PORT,
        cache_dir: env.cacheDir,
        load_ms: loadMs ?? Date.now() - loadStarted,
        error: loadError,
        calls: embedCalls,
        texts: embedTexts,
        last_latency_ms: lastLatencyMs,
      })
    }
    if (req.method === 'POST' && url.pathname === '/embed') {
      if (state !== 'ready') return json(res, 503, { ok: false, error: `model ${state}`, detail: loadError })
      const body = await readJson(req)
      const texts = normalizeInputs(body)
      const result = await embed(texts)
      return json(res, 200, {
        embeddings: result.vectors,
        dim: result.dim,
        model: MODEL,
        latency_ms: result.latencyMs,
      })
    }
    return json(res, 404, { ok: false, error: 'not found' })
  } catch (error) {
    return json(res, 500, { ok: false, error: error?.message || String(error) })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[bge-m3] listening on http://${HOST}:${PORT}`)
})

try {
  console.log(`[bge-m3] loading ${MODEL} (quantized ONNX, cache ${env.cacheDir})`)
  extractor = await pipeline('feature-extraction', MODEL, { quantized: true })
  loadMs = Date.now() - loadStarted
  state = 'ready'
  console.log(`[bge-m3] model ready in ${loadMs}ms`)
} catch (error) {
  state = 'failed'
  loadError = error?.message || String(error)
  console.error('[bge-m3] model failed:', loadError)
}
