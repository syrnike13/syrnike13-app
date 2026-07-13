import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const EXPECTED_FILES = [
  'livekit.dll',
  'livekit_ffi.dll',
  'native-manifest.json',
  'syrnike_hotkey.node',
  'syrnike_overlay.node',
  'syrnike_media.node',
]

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(packageRoot, '..', '..')
const packageDistRoot = path.resolve(packageRoot, 'dist')
const explicitTarget = process.argv[2]
const targetRoot = path.resolve(
  explicitTarget || path.resolve(packageDistRoot, 'win32-x64'),
)

if (!explicitTarget) {
  const packageEntries = readdirSync(packageDistRoot, { withFileTypes: true })
  if (
    packageEntries.length !== 1 ||
    packageEntries[0]?.name !== 'win32-x64' ||
    !packageEntries[0].isDirectory()
  ) {
    throw new Error('Desktop-native dist must contain only win32-x64')
  }
}
const actualFiles = readdirSync(targetRoot, { withFileTypes: true })

if (actualFiles.some((entry) => !entry.isFile())) {
  throw new Error(`Native artifact directory contains a nested directory: ${targetRoot}`)
}

const actualNames = actualFiles.map((entry) => entry.name).sort()
const expectedNames = [...EXPECTED_FILES].sort()
if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
  throw new Error(
    `Unexpected native package contents. Expected ${EXPECTED_FILES.join(', ')}, got ${actualNames.join(', ')}`,
  )
}

if (actualNames.some((name) => name.toLowerCase().endsWith('.exe'))) {
  throw new Error('Custom runtime EXE found in the native artifact directory')
}

const manifest = JSON.parse(
  readFileSync(path.resolve(targetRoot, 'native-manifest.json'), 'utf8'),
)
const desktopRequire = createRequire(
  path.resolve(repoRoot, 'apps', 'desktop', 'package.json'),
)
const expectedAppVersion =
  process.env.SYRNIKE_DESKTOP_BUILD_VERSION ||
  readFileSync(path.resolve(repoRoot, 'VERSION'), 'utf8').trim()
const expectedReleaseChannel =
  process.env.SYRNIKE_DESKTOP_CHANNEL === 'nightly' ? 'nightly' : 'stable'
const expectedElectronVersion = desktopRequire('electron/package.json').version
const expectedCommitSha = process.env.GITHUB_SHA || gitCommitSha()
if (
  manifest.schemaVersion !== 1 ||
  manifest.contractVersion !== 3 ||
  manifest.platform !== 'win32' ||
  manifest.arch !== 'x64' ||
  manifest.appVersion !== expectedAppVersion ||
  manifest.releaseChannel !== expectedReleaseChannel ||
  manifest.electronVersion !== expectedElectronVersion ||
  manifest.napiVersion !== 8 ||
  manifest.commitSha !== expectedCommitSha ||
  !/^[0-9a-f]{40}$/i.test(manifest.commitSha) ||
  typeof manifest.appVersion !== 'string' ||
  typeof manifest.electronVersion !== 'string' ||
  !Number.isSafeInteger(manifest.napiVersion) ||
  manifest.liveKitVersion !== '1.3.0' ||
  manifest.liveKitRevision !== '7596552cdba189fd908c8daa1b55c353efd015a3' ||
  manifest.liveKitRustRevision !== 'dad794d414fda9e8c1de83af1c0f190506a15f8f' ||
  !Array.isArray(manifest.files)
) {
  throw new Error('Native artifact manifest has an unsupported shape')
}

const expectedHashes = new Map(
  manifest.files.map((entry) => [entry.name, entry.sha256]),
)
if (
  expectedHashes.size !== EXPECTED_FILES.length - 1 ||
  manifest.files.length !== EXPECTED_FILES.length - 1
) {
  throw new Error('Native artifact manifest file allowlist mismatch')
}
for (const name of EXPECTED_FILES.filter((entry) => entry !== 'native-manifest.json')) {
  const expected = expectedHashes.get(name)
  const actual = createHash('sha256')
    .update(readFileSync(path.resolve(targetRoot, name)))
    .digest('hex')
  if (!expected || expected !== actual) {
    throw new Error(`SHA-256 mismatch for ${name}`)
  }
}

console.info(`[desktop-native] verified DLL-only artifact set at ${targetRoot}`)

function gitCommitSha() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (result.status !== 0 || !/^[0-9a-f]{40}$/i.test(result.stdout.trim())) {
    throw new Error('Cannot determine the expected native artifact commit')
  }
  return result.stdout.trim()
}
