import { spawnSync } from 'node:child_process'
import path from 'node:path'

if (process.platform !== 'win32') {
  console.info('[desktop] skipping Windows native package verification')
  process.exit(0)
}

const desktopRoot = path.resolve(import.meta.dirname, '..')
const repoRoot = path.resolve(desktopRoot, '..', '..')
const outputDirectory =
  process.env.SYRNIKE_DESKTOP_CHANNEL === 'nightly'
    ? 'release-nightly'
    : 'release'
const nativeDirectory = path.resolve(
  desktopRoot,
  outputDirectory,
  'win-unpacked',
  'resources',
  'native',
  'win32-x64',
)
const hookVerifier = path.resolve(
  repoRoot,
  'packages',
  'desktop-native',
  'scripts',
  'verify-artifacts.mjs',
)
const mediaVerifier = path.resolve(
  repoRoot,
  'packages',
  'windows-media-engine',
  'scripts',
  'verify-artifacts.mjs',
)
const mediaDirectory = path.resolve(
  desktopRoot,
  outputDirectory,
  'win-unpacked',
  'resources',
  'media-engine',
  'win32-x64',
)

runVerifier(hookVerifier, nativeDirectory)
runVerifier(mediaVerifier, mediaDirectory)

function runVerifier(verifier, directory) {
  const result = spawnSync(process.execPath, [verifier, directory], {
    stdio: 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
