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

const CONTRACT_VERSION = 10
const NAPI_VERSION = 8
const ARCH = 'x64'
const NATIVE_FILES = ['syrnike_hotkey.node', 'syrnike_overlay.node']

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
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
const windowsCmakeBin = resolveWindowsCmakeBin()

const args = new Set(process.argv.slice(2))
const configIndex = process.argv.indexOf('--config')
const configuration = configIndex >= 0 ? process.argv[configIndex + 1] : 'Release'
const shouldStage = !args.has('--no-stage') && configuration === 'Release'
const enableAsan = args.has('--asan')

if (configuration !== 'Debug' && configuration !== 'Release') {
  throw new Error(`Unsupported native build configuration: ${configuration}`)
}

if (process.platform !== 'win32') {
  if (shouldStage && existsSync(packageDistRoot)) {
    rmSync(packageDistRoot, { recursive: true, force: true })
  }
  console.info('[desktop-native] skipping Windows x64 hook build')
  process.exit(0)
}

const desktopRequire = createRequire(
  path.resolve(repoRoot, 'apps', 'desktop', 'package.json'),
)
const electronVersion = desktopRequire('electron/package.json').version
const buildCommitSha = process.env.GITHUB_SHA || gitCommitSha()

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
  `--CDNAPI_VERSION=${NAPI_VERSION}`,
  `--CDSYRNIKE_ENABLE_ASAN=${enableAsan ? 'ON' : 'OFF'}`,
  `--CDSYRNIKE_NATIVE_COMMIT=${buildCommitSha}`,
])

if (!shouldStage) {
  console.info(`[desktop-native] ${configuration} hook build completed without staging`)
  process.exit(0)
}

const sources = new Map(
  NATIVE_FILES.map((name) => [
    name,
    requiredFile(path.resolve(buildRoot, configuration, name)),
  ]),
)
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
  commitSha: buildCommitSha,
  electronVersion,
  napiVersion: NAPI_VERSION,
  capabilities: ['hotkeys', 'overlay'],
  files: NATIVE_FILES.map((name) => ({
    name,
    sha256: sha256(sources.get(name)),
  })),
}

stageArtifacts(distRoot, sources, manifest)
stageArtifacts(desktopStageRoot, sources, manifest)
console.info(`[desktop-native] staged hook addons for Electron ${electronVersion}`)

function run(command, commandArgs) {
  const usePnpmLauncher = process.platform === 'win32' && command === 'pnpm'
  if (usePnpmLauncher && !process.env.npm_execpath) {
    throw new Error('npm_execpath is required to launch pnpm')
  }
  const launcher = usePnpmLauncher ? process.env.npm_execpath : command
  const launcherIsExecutable = path.extname(launcher).toLowerCase() === '.exe'
  const executable = launcherIsExecutable
    ? launcher
    : usePnpmLauncher
      ? process.execPath
      : command
  const spawnArgs = launcherIsExecutable
    ? commandArgs
    : usePnpmLauncher
      ? [launcher, ...commandArgs]
      : commandArgs
  const result = spawnSync(executable, spawnArgs, {
    cwd: packageRoot,
    stdio: 'inherit',
    shell: false,
    env: {
      ...process.env,
      ...(windowsCmakeBin
        ? {
            PATH: `${windowsCmakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
          }
        : {}),
    },
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
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function gitCommitSha() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  if (result.status !== 0 || !/^[0-9a-f]{40}$/i.test(result.stdout.trim())) {
    throw new Error('Cannot determine the native artifact commit')
  }
  return result.stdout.trim()
}

function resolveWindowsCmakeBin() {
  if (process.platform !== 'win32') return undefined
  const candidates = [
    'C:/Program Files/Microsoft Visual Studio/18/Community/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin',
    'C:/Program Files/Microsoft Visual Studio/18/Enterprise/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin',
  ]
  return candidates.find((candidate) =>
    existsSync(path.resolve(candidate, 'cmake.exe')),
  )
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
