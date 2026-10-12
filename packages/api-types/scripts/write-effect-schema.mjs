import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const sourcePath = path.join(packageRoot, 'OpenAPI.json')
const outputPath = path.join(packageRoot, 'src', 'effect-schema.ts')
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'syrnike-api-schema-'))
const temporarySpecPath = path.join(temporaryRoot, 'OpenAPI.json')

try {
  const openApi = JSON.parse(await readFile(sourcePath, 'utf8'))
  removeUnsupportedPatterns(openApi)
  await writeFile(temporarySpecPath, JSON.stringify(openApi))

  const generated = spawnSync(
    'openapigen',
    [
      '--spec',
      temporarySpecPath,
      '--format',
      'httpclient',
      '--name',
      'SyrnikeApi',
    ],
    {
      cwd: packageRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      shell: process.platform === 'win32',
    },
  )

  if (generated.stderr) process.stderr.write(generated.stderr)
  if (generated.status !== 0) {
    throw new Error(`openapigen exited with code ${generated.status}`)
  }

  const definitionsMarker = '// non-recursive definitions'
  const clientMarker = '\nexport interface OperationConfig'
  const definitionsStart = generated.stdout.indexOf(definitionsMarker)
  const clientStart = generated.stdout.indexOf(clientMarker)
  if (definitionsStart < 0 || clientStart < 0) {
    throw new Error('Unexpected openapigen output format')
  }

  const definitions = generated.stdout
    .slice(definitionsStart, clientStart)
    .trimEnd()
  const source = [
    '// This file is generated from packages/api-types/OpenAPI.json.',
    '// Patterns requiring inline flags or Unicode property escapes are omitted',
    '// because openapigen emits JavaScript RegExp values without those flags.',
    'import * as Schema from "effect/Schema"',
    '',
    definitions,
    '',
  ].join('\n')

  await writeFile(outputPath, source)
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}

function removeUnsupportedPatterns(value) {
  if (Array.isArray(value)) {
    value.forEach(removeUnsupportedPatterns)
    return
  }
  if (value === null || typeof value !== 'object') return

  if (
    typeof value.pattern === 'string'
    && (value.pattern.includes('(?i)') || /\\[pP]\{/.test(value.pattern))
  ) {
    delete value.pattern
  }
  Object.values(value).forEach(removeUnsupportedPatterns)
}
