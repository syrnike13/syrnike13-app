import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const LIVEKIT_VERSION = '1.3.0'
const CONTRACT_VERSION = 1
const LIVEKIT_SHA256 =
  '27a8707348d7fb094023b7c8af29e26b8e4085a4dab75d26be3968f29b2269c3'
const NAPI_VERSION = 8
const ARCH = 'x64'
const NATIVE_FILES = [
  'syrnike_media.node',
  'syrnike_hooks.node',
  'livekit.dll',
  'livekit_ffi.dll',
]

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(packageRoot, '..', '..')
const nativeRoot = path.resolve(packageRoot, 'native')
const buildRoot = path.resolve(packageRoot, 'build')
const packageDistRoot = path.resolve(packageRoot, 'dist')
const distRoot = path.resolve(packageDistRoot, 'win32-x64')
const desktopStageRoot = path.resolve(
  repoRoot,
  'apps',
  'desktop',
  'out',
  'native',
  'win32-x64',
)
const buildConfigurationFile = path.resolve(buildRoot, '.syrnike-build-config.json')
const cmakeCacheFile = path.resolve(buildRoot, 'CMakeCache.txt')

const args = new Set(process.argv.slice(2))
const configIndex = process.argv.indexOf('--config')
const configuration = configIndex >= 0 ? process.argv[configIndex + 1] : 'Release'
const shouldStage = !args.has('--no-stage') && configuration === 'Release'
const enableAsan = args.has('--asan')

if (configuration !== 'Debug' && configuration !== 'Release') {
  throw new Error(`Unsupported native build configuration: ${configuration}`)
}

if (process.platform !== 'win32') {
  if (shouldStage) {
    rmSync(path.resolve(packageRoot, 'dist'), { recursive: true, force: true })
  }
  console.info('[desktop-native] skipping Windows x64 native build')
  process.exit(0)
}

const desktopRequire = createRequire(
  path.resolve(repoRoot, 'apps', 'desktop', 'package.json'),
)
const electronVersion = desktopRequire('electron/package.json').version
const expectedBuildConfiguration = JSON.stringify(
  {
    arch: ARCH,
    electronVersion,
    liveKitSha256: LIVEKIT_SHA256,
    liveKitVersion: LIVEKIT_VERSION,
    napiVersion: NAPI_VERSION,
    asan: enableAsan,
  },
  null,
  2,
)

const hasBuildConfiguration = existsSync(buildConfigurationFile)
const buildConfigurationChanged =
  hasBuildConfiguration &&
  readFileSync(buildConfigurationFile, 'utf8') !== `${expectedBuildConfiguration}\n`
const unownedCmakeCache = !hasBuildConfiguration && existsSync(cmakeCacheFile)

if (buildConfigurationChanged || unownedCmakeCache) {
  console.info('[desktop-native] native dependency versions changed; cleaning CMake cache')
  rmSync(buildRoot, { recursive: true, force: true })
}

mkdirSync(buildRoot, { recursive: true })

run('pnpm', [
  'exec',
  'cmake-js',
  'compile',
  '--directory',
  nativeRoot,
  '--out',
  buildRoot,
  '--runtime',
  'electron',
  '--runtime-version',
  electronVersion,
  '--arch',
  ARCH,
  '--config',
  configuration,
  `--CDLIVEKIT_SDK_VERSION=v${LIVEKIT_VERSION}`,
  `--CDLIVEKIT_SDK_SHA256=${LIVEKIT_SHA256}`,
  '--CDLIVEKIT_LOCAL_SDK_DIR=',
  `--CDNAPI_VERSION=${NAPI_VERSION}`,
  `--CDSYRNIKE_ENABLE_ASAN=${enableAsan ? 'ON' : 'OFF'}`,
])

writeFileSync(buildConfigurationFile, `${expectedBuildConfiguration}\n`, 'utf8')

if (!shouldStage) {
  console.info(`[desktop-native] ${configuration} build completed without staging`)
  process.exit(0)
}

const liveKitBinRoot = path.resolve(
  buildRoot,
  '_deps',
  'livekit-sdk',
  `livekit-sdk-windows-x64-${LIVEKIT_VERSION}`,
  'bin',
)
const sources = new Map([
  [
    'syrnike_media.node',
    requiredFile(path.resolve(buildRoot, configuration, 'syrnike_media.node')),
  ],
  [
    'syrnike_hooks.node',
    requiredFile(path.resolve(buildRoot, configuration, 'syrnike_hooks.node')),
  ],
  ['livekit.dll', requiredFile(path.resolve(liveKitBinRoot, 'livekit.dll'))],
  [
    'livekit_ffi.dll',
    requiredFile(path.resolve(liveKitBinRoot, 'livekit_ffi.dll')),
  ],
])

const manifest = {
  schemaVersion: 1,
  contractVersion: CONTRACT_VERSION,
  platform: 'win32',
  arch: ARCH,
  appVersion:
    process.env.SYRNIKE_DESKTOP_BUILD_VERSION ||
    readFileSync(path.resolve(repoRoot, 'VERSION'), 'utf8').trim(),
  releaseChannel:
    process.env.SYRNIKE_DESKTOP_CHANNEL === 'nightly' ? 'nightly' : 'stable',
  commitSha: process.env.GITHUB_SHA || gitCommitSha(),
  electronVersion,
  napiVersion: NAPI_VERSION,
  liveKitVersion: LIVEKIT_VERSION,
  files: NATIVE_FILES.map((name) => ({
    name,
    sha256: sha256(sources.get(name)),
  })),
}

// `dist` previously contained an obsolete single-addon build at its root.
// Recreate the complete distribution so stale DLLs can never coexist with the
// two-module contract or leak into another packaging flow.
rmSync(packageDistRoot, { recursive: true, force: true })
stageArtifacts(distRoot, sources, manifest)

// The development runtime resolves binaries from apps/desktop/out. Remove the
// entire generated native directory first so an old helper EXE can never leak
// into a development run or an installer.
const desktopNativeRoot = path.dirname(desktopStageRoot)
rmSync(desktopNativeRoot, { recursive: true, force: true })
stageArtifacts(desktopStageRoot, sources, manifest)

console.info(`[desktop-native] staged DLL runtime for Electron ${electronVersion}`)

function run(command, commandArgs) {
  const executable = process.platform === 'win32' ? `${command}.cmd` : command
  const result = spawnSync(executable, commandArgs, {
    cwd: packageRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function requiredFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Required native artifact was not built: ${filePath}`)
  }
  return filePath
}

function sha256(filePath) {
  if (!filePath) throw new Error('Cannot hash a missing native artifact')
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function gitCommitSha() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (result.status !== 0) return 'unknown'
  return result.stdout.trim()
}

function stageArtifacts(targetRoot, sourceFiles, nativeManifest) {
  rmSync(targetRoot, { recursive: true, force: true })
  mkdirSync(targetRoot, { recursive: true })
  for (const [name, source] of sourceFiles) {
    copyFileSync(source, path.resolve(targetRoot, name))
  }
  writeFileSync(
    path.resolve(targetRoot, 'native-manifest.json'),
    `${JSON.stringify(nativeManifest, null, 2)}\n`,
    'utf8',
  )
}
