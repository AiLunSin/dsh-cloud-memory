import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CacheStore } from '../lib/cache.js'

const root = path.dirname(fileURLToPath(import.meta.url))
const l2Path = path.join(root, '.redis-l2.json')
const logger = { info() {}, warn() {}, error() {} }

function parseCommand(buffer) {
  if (buffer.length === 0 || buffer[0] !== 42) return null
  let offset = buffer.indexOf('\r\n')
  if (offset < 0) return null
  const count = Number(buffer.toString('utf8', 1, offset))
  offset += 2
  const args = []
  for (let index = 0; index < count; index += 1) {
    if (buffer[offset] !== 36) return null
    const lineEnd = buffer.indexOf('\r\n', offset)
    if (lineEnd < 0) return null
    const length = Number(buffer.toString('utf8', offset + 1, lineEnd))
    const start = lineEnd + 2
    if (buffer.length < start + length + 2) return null
    args.push(buffer.toString('utf8', start, start + length))
    offset = start + length + 2
  }
  return { args, offset }
}

function encodeBulk(value) {
  if (value === null || value === undefined) return '$-1\r\n'
  return `$${Buffer.byteLength(value)}\r\n${value}\r\n`
}

function patternMatch(pattern, key) {
  if (!pattern || pattern === '*') return true
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(key)
}

const server = net.createServer((socket) => {
  const store = new Map()
  let buffer = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      const parsed = parseCommand(buffer)
      if (!parsed) break
      buffer = buffer.subarray(parsed.offset)
      const [command, ...args] = parsed.args
      const upper = command.toUpperCase()
      if (upper === 'PING') socket.write('+PONG\r\n')
      else if (upper === 'AUTH' || upper === 'SELECT') socket.write('+OK\r\n')
      else if (upper === 'SET') {
        store.set(args[0], args[1])
        socket.write('+OK\r\n')
      } else if (upper === 'GET') {
        socket.write(encodeBulk(store.has(args[0]) ? store.get(args[0]) : null))
      } else if (upper === 'DEL') {
        let removed = 0
        for (const key of args) if (store.delete(key)) removed += 1
        socket.write(`:${removed}\r\n`)
      } else if (upper === 'SCAN') {
        const matchIndex = args.indexOf('MATCH')
        const pattern = matchIndex >= 0 ? args[matchIndex + 1] : '*'
        const keys = [...store.keys()].filter((key) => patternMatch(pattern, key))
        const parts = [`*2\r\n`, encodeBulk('0'), `*${keys.length}\r\n`, ...keys.map(encodeBulk)]
        socket.write(parts.join(''))
      } else {
        socket.write(`-ERR unknown command '${command}'\r\n`)
      }
    }
  })
})

const cacheConfig = {
  ttlSearch: 300, ttlEmbedding: 604800, ttlNegative: 30, ttlJitterRatio: 0,
  l1MaxEntries: 0, l2MaxEntries: 0, l2MaxBytes: 0, l2Path, l3Url: '', singleflightTimeoutMs: 250,
}

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const cache = new CacheStore({
    config: { ...cacheConfig, l3Url: `redis://127.0.0.1:${port}/0` },
    logger,
  })
  await cache.open()
  console.log('l3 status', cache.l3.status())
  cache.set('m:s:abc', JSON.stringify({ ok: true }), 60)
  await new Promise((resolve) => setTimeout(resolve, 30))
  const hit = await cache.get('m:s:abc')
  console.log('l3 hit', hit)
  if (!hit || hit.level !== 'l3') throw new Error('L3 hit failed')
  await cache.publishVersion('local', 7)
  const version = await cache.remoteVersion('local')
  console.log('l3 version', version)
  if (version !== 7) throw new Error('L3 version failed')
  const purged = await cache.purge('all', 'all')
  console.log('l3 purge', purged)
  await cache.close()
  await fs.rm(l2Path, { force: true })
  server.close()
  console.log('REDIS OK')
}

main().catch(async (error) => {
  console.error(error)
  await fs.rm(l2Path, { force: true }).catch(() => {})
  server.close()
  process.exitCode = 1
})
