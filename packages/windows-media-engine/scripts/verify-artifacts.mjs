import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const EXPECTED_FILES = ['media-manifest.json', 'windows_media.node']
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(packageRoot, '..', '..')
const protocolSource = readFileSync(
  path.resolve(
    repoRoot,
    'apps',
    'desktop',
    'src',
    'main',
    'media-runtime',
    'contract.ts',
  ),
  'utf8',
)
const targetRoot = path.resolve(
  process.argv[2] || path.resolve(packageRoot, 'dist', 'win32-x64'),
)

if (process.platform !== 'win32') {
  console.info('[windows-media-engine] skipping Windows artifact verification')
  process.exit(0)
}

const entries = readdirSync(targetRoot, { withFileTypes: true })
if (entries.some((entry) => !entry.isFile())) {
  throw new Error('Media engine artifact directory contains a nested entry')
}
const names = entries.map((entry) => entry.name).sort()
if (JSON.stringify(names) !== JSON.stringify([...EXPECTED_FILES].sort())) {
  throw new Error(`Unexpected media engine artifacts: ${names.join(', ')}`)
}

const manifest = JSON.parse(
  readFileSync(path.resolve(targetRoot, 'media-manifest.json'), 'utf8'),
)
const desktopRequire = createRequire(
  path.resolve(repoRoot, 'apps', 'desktop', 'package.json'),
)
const expectedVersion =
  process.env.SYRNIKE_DESKTOP_BUILD_VERSION ||
  readFileSync(path.resolve(repoRoot, 'VERSION'), 'utf8').trim()
const expectedChannel =
  process.env.SYRNIKE_DESKTOP_CHANNEL === 'nightly' ? 'nightly' : 'stable'
const expectedCommit = process.env.GITHUB_SHA || gitCommitSha()
if (
  manifest.schemaVersion !== 1 ||
  manifest.protocolVersion !== protocolConstant('MEDIA_LIFECYCLE_PROTOCOL_VERSION') ||
  manifest.platform !== 'win32' ||
  manifest.arch !== 'x64' ||
  manifest.appVersion !== expectedVersion ||
  manifest.releaseChannel !== expectedChannel ||
  manifest.commitSha !== expectedCommit ||
  manifest.electronVersion !== desktopRequire('electron/package.json').version ||
  manifest.napiVersion !== 8 ||
  JSON.stringify(manifest.capabilities) !==
    JSON.stringify(['lifecycle', 'control-v2', 'diagnostics-v2']) ||
  JSON.stringify(manifest.limits) !== JSON.stringify({
    controlQueue: protocolConstant('MEDIA_LIFECYCLE_CONTROL_QUEUE_CAPACITY'),
    eventQueue: protocolConstant('MEDIA_LIFECYCLE_EVENT_QUEUE_CAPACITY'),
    startDeadlineMs: protocolConstant('MEDIA_LIFECYCLE_START_TIMEOUT_MS'),
    pingDeadlineMs: protocolConstant('MEDIA_LIFECYCLE_PING_TIMEOUT_MS'),
    shutdownDeadlineMs: protocolConstant('MEDIA_LIFECYCLE_SHUTDOWN_TIMEOUT_MS'),
    maxIdentifierLength: protocolConstant('MEDIA_LIFECYCLE_MAX_IDENTIFIER_LENGTH'),
    maxRemoteVideoDemands: protocolConstant('MEDIA_LIFECYCLE_MAX_REMOTE_VIDEO_DEMANDS'),
    maxDiagnosticMetrics: protocolConstant('MEDIA_LIFECYCLE_MAX_DIAGNOSTIC_METRICS'),
    maxDiagnosticFields: protocolConstant('MEDIA_LIFECYCLE_MAX_DIAGNOSTIC_FIELDS'),
    maxRequestDeadlineMs: protocolConstant('MEDIA_LIFECYCLE_MAX_DEADLINE_MS'),
  }) ||
  !Array.isArray(manifest.files) ||
  manifest.files.length !== 1 ||
  manifest.files[0]?.name !== 'windows_media.node'
) {
  throw new Error('Media engine manifest has an unsupported shape')
}
const binary = readFileSync(path.resolve(targetRoot, 'windows_media.node'))
const hash = createHash('sha256').update(binary).digest('hex')
if (manifest.files[0].sha256 !== hash) {
  throw new Error('Media engine SHA-256 mismatch')
}
console.info(`[windows-media-engine] verified lifecycle artifacts at ${targetRoot}`)

function gitCommitSha() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (result.status !== 0 || !/^[0-9a-f]{40}$/i.test(result.stdout.trim())) {
    throw new Error('Cannot determine the media engine commit')
  }
  return result.stdout.trim()
}

function protocolConstant(name) {
  const match = protocolSource.match(
    new RegExp(`export const ${name} = ([0-9_]+)`),
  )
  if (!match) throw new Error(`Missing protocol source constant: ${name}`)
  return Number(match[1].replaceAll('_', ''))
}
