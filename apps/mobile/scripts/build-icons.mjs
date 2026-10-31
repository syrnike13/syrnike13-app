// Bundles the iconify icons used by the icon registry into the app, so icons
// never load from the network. Run after adding or changing an
// `iconifyIcon('prefix:name')` call: `pnpm --filter @syrnike13/mobile icons:build`.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getIconData } from '@iconify/utils'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const registry = join(root, 'src/components/icons/registry.ts')
const outFile = join(root, 'src/components/icons/iconify-icons.json')

const ids = new Set()
for (const match of readFileSync(registry, 'utf8').matchAll(/iconifyIcon\(\s*'([a-z0-9-]+:[a-z0-9-]+)'/g)) {
  ids.add(match[1])
}

const collections = new Map()
const icons = {}
for (const id of [...ids].sort()) {
  const [prefix, name] = id.split(':')
  if (!collections.has(prefix)) {
    collections.set(prefix, require(`@iconify-json/${prefix}/icons.json`))
  }
  const data = getIconData(collections.get(prefix), name)
  if (!data) throw new Error(`Icon not found in @iconify-json/${prefix}: ${id}`)
  icons[id] = {
    body: data.body,
    width: data.width ?? collections.get(prefix).width ?? 16,
    height: data.height ?? collections.get(prefix).height ?? 16,
  }
}

writeFileSync(outFile, `${JSON.stringify(icons, null, 2)}\n`)
console.log(`iconify-icons.json: ${Object.keys(icons).length} icons`)
