import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EmbeddingProvider } from '../lib/embedding.js'

const root = path.dirname(fileURLToPath(import.meta.url))
const l2Path = path.join(root, '.chunk-l2.json')

const requests = []
const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  requests.push(body.inputs.length)
  const embeddings = body.inputs.map(() => {
    const vector = new Array(1024).fill(0)
    vector[0] = 1
    return vector
  })
  const payload = JSON.stringify({ embeddings, dim: 1024 })
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
})

const cache = {
  async get() { return null },
  set() {},
  recordEmbedding() {},
}

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const provider = new EmbeddingProvider({
    config: {
      provider: 'tei', api: 'tei', baseUrl: `http://127.0.0.1:${port}`,
      model: 'BAAI/bge-m3', dim: 1024, timeoutMs: 5000,
      apiKeyEnv: '', fallbackToLocal: false, ttlEmbedding: 60,
    },
    cache,
    logger: { info() {}, warn() {}, error() {} },
  })
  const texts = Array.from({ length: 70 }, (_, index) => `text ${index}`)
  const result = await provider.embedMany(texts)
  console.log('requests', requests, 'vectors', result.vectors.length, 'dim', result.vectors[0]?.length)
  if (requests.length !== 3 || requests.join(',') !== '32,32,6') {
    throw new Error(`unexpected chunking: ${requests.join(',')}`)
  }
  if (result.vectors.length !== 70 || result.vectors.some((vector) => vector?.length !== 1024)) {
    throw new Error('chunked vectors are incomplete')
  }
  if (result.error) throw new Error(`unexpected embedding error: ${result.error}`)
  await fs.rm(l2Path, { force: true }).catch(() => {})
  server.close()
  console.log('CHUNK OK')
}

main().catch(async (error) => {
  console.error(error)
  await fs.rm(l2Path, { force: true }).catch(() => {})
  server.close()
  process.exitCode = 1
})
