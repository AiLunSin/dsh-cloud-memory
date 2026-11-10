/**
 * @xenova/transformers imports sharp for image pipelines. This service only
 * embeds text, and sharp's native binary cannot be installed in the current
 * sandboxed npm run. Replace it with a text-only stub after `npm install
 * --ignore-scripts`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const sharpDir = path.join(here, 'node_modules', 'sharp')
const brokenDir = path.join(here, 'node_modules', 'sharp-broken')
const binary = path.join(sharpDir, 'build', 'Release', 'sharp-win32-x64.node')

if (fs.existsSync(binary)) {
  console.log('[sharp] native binary present, leaving installation unchanged')
  process.exit(0)
}

if (fs.existsSync(sharpDir)) {
  if (fs.existsSync(path.join(sharpDir, 'lib', 'sharp.js'))) {
    fs.rmSync(brokenDir, { recursive: true, force: true })
    fs.renameSync(sharpDir, brokenDir)
    console.log('[sharp] moved unusable install to node_modules/sharp-broken')
  }
}

fs.mkdirSync(sharpDir, { recursive: true })
fs.writeFileSync(path.join(sharpDir, 'package.json'), JSON.stringify({
  name: 'sharp',
  version: '0.32.6',
  description: 'Text-only stub for @xenova/transformers; image processing is not used.',
  main: 'index.js',
}, null, 2))
fs.writeFileSync(path.join(sharpDir, 'index.js'), `// Text-only stub. Any accidental image call fails loudly.
function sharp() {
  throw new Error('sharp is not installed in this text-only embedding service')
}
sharp.cache = () => {}
sharp.concurrency = () => {}
sharp.simd = () => false
sharp.default = sharp
module.exports = sharp
`)
console.log('[sharp] text-only stub installed')
