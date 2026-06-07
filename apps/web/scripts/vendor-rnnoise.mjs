import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const commit = '860d8053d4917389dfdebb20d88d0bb6ce950bda'
const cdnBase = `https://cdn.jsdelivr.net/gh/dadadah/livekit-rnnoise-processor@${commit}/dist`
const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../public/rnnoise',
)

const files = ['DenoiserWorklet.js', 'rnnoise.wasm']

await mkdir(outDir, { recursive: true })

for (const file of files) {
  const url = `${cdnBase}/${file}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  const target = path.join(outDir, file)
  await writeFile(target, bytes)
  console.log(`Wrote ${target} (${bytes.length} bytes)`)
}

console.log('RNNoise vendor sync complete.')
