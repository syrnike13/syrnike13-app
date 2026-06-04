import { readFile, writeFile } from 'node:fs/promises'

const openApi = JSON.parse(
  await readFile(new URL('../OpenAPI.json', import.meta.url), 'utf8'),
)
const names = Object.keys(openApi.components?.schemas ?? {})

const lines = [
  '// This file is generated from packages/api-types/OpenAPI.json.',
  "import type { components } from './schema'",
  '',
]

for (const name of names) {
  const validIdentifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
  const exportName = validIdentifier
    ? name
    : name.replace(/[^A-Za-z0-9_$]+(.)?/g, (_, char = '') => char.toUpperCase())

  if (!exportName || !/^[A-Za-z_$]/.test(exportName)) continue

  lines.push(`export type ${exportName} = components['schemas']['${name}']`)
}

await writeFile(new URL('../src/types.ts', import.meta.url), `${lines.join('\n')}\n`)
