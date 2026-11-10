/** Download the transformers.js BGE-M3 ONNX files from ModelScope. */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const base = 'https://www.modelscope.cn/models/Xenova/bge-m3/resolve/master/'
const target = path.join(here, '.cache', 'Xenova', 'bge-m3')
const files = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'sentencepiece.bpe.model',
  'onnx/model_quantized.onnx',
]

let downloaded = 0
let total = 0
let lastLog = Date.now()

async function download(relative) {
  const destination = path.join(target, relative)
  await fsp.mkdir(path.dirname(destination), { recursive: true })
  const url = base + relative.split('/').map(encodeURIComponent).join('/')
  const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(30000) })
  if (!head.ok) throw new Error(`HEAD ${url} -> ${head.status}`)
  const length = Number(head.headers.get('content-length') || 0)
  const existing = await fsp.stat(destination).catch(() => null)
  if (existing && length > 0 && existing.size === length) {
    console.log(`[skip] ${relative} (${(length / 1e6).toFixed(1)} MB)`)
    downloaded += length
    total += length
    return
  }
  total += length
  console.log(`[get ] ${relative} (${(length / 1e6).toFixed(1)} MB)`)
  const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60 * 1000) })
  if (!response.ok || !response.body) throw new Error(`GET ${url} -> ${response.status}`)
  const temp = `${destination}.part`
  const output = fs.createWriteStream(temp)
  let fileBytes = 0
  const stream = Readable.fromWeb(response.body)
  stream.on('data', (chunk) => {
    fileBytes += chunk.length
    downloaded += chunk.length
    if (Date.now() - lastLog > 3000) {
      lastLog = Date.now()
      const pct = total ? ((downloaded / total) * 100).toFixed(1) : '?'
      console.log(`[....] ${pct}%  ${(downloaded / 1e6).toFixed(1)} MB`)
    }
  })
  await pipeline(stream, output)
  if (length > 0 && fileBytes !== length) throw new Error(`size mismatch for ${relative}: ${fileBytes} != ${length}`)
  await fsp.rename(temp, destination)
  console.log(`[done] ${relative} (${(fileBytes / 1e6).toFixed(1)} MB)`)
}

for (const relative of files) {
  await download(relative)
}
console.log('MODEL DOWNLOAD OK')
