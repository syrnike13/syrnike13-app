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

const PROTOCOL_VERSION = 1
const NAPI_VERSION = 8
const ARCH = 'x64'
const MEDIA_FILES = ['windows_media.node']

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(packageRoot, '..', '..')
const nativeRoot = path.resolve(packageRoot, 'native')
const buildRoot = path.resolve(packageRoot, 'build')
const distRoot = path.resolve(packageRoot, 'dist', 'win32-x64')
const desktopStageRoot = path.resolve(
  repoRoot,
  'apps',
  'desktop',
  'out',
  'media-native',
  'win32-x64',
)
const windowsCmakeBin = resolveWindowsCmakeBin()

const args = new Set(process.argv.slice(2))
const configIndex = process.argv.indexOf('--config')
const configuration = configIndex >= 0 ? process.argv[configIndex + 1] : 'Release'
const shouldStage = !args.has('--no-stage') && configuration === 'Release'
const enableAsan = args.has('--asan')

if (configuration !== 'Debug' && configuration !== 'Release') {
  throw new Error(`Unsupported media engine configuration: ${configuration}`)
}

if (process.platform !== 'win32') {
  if (shouldStage) rmSync(path.resolve(packageRoot, 'dist'), { recursive: true, force: true })
  console.info('[windows-media-engine] skipping Windows x64 lifecycle build')
  process.exit(0)
}

const desktopRequire = createRequire(
  path.resolve(repoRoot, 'apps', 'desktop', 'package.json'),
)
const electronVersion = desktopRequire('electron/package.json').version
const commitSha = process.env.GITHUB_SHA || gitCommitSha()

const cmakeArgs = [
  'exec',
  'cmake-js',
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
  `--CDWINDOWS_MEDIA_ENABLE_ASAN=${enableAsan ? 'ON' : 'OFF'}`,
  `--CDWINDOWS_MEDIA_COMMIT=${commitSha}`,
]

// cmake-js compile reuses an existing cache without applying changed -D values.
// Configure explicitly so switching between Release, Debug, and ASAN is real.
run('pnpm', [...cmakeArgs.slice(0, 2), 'configure', ...cmakeArgs.slice(2)])
run('pnpm', [...cmakeArgs.slice(0, 2), 'compile', ...cmakeArgs.slice(2)])

if (!shouldStage) {
  console.info(`[windows-media-engine] ${configuration} lifecycle build completed`)
  process.exit(0)
}

const sources = new Map(
  MEDIA_FILES.map((name) => [
    name,
    requiredFile(path.resolve(buildRoot, configuration, name)),
  ]),
)
const manifest = {
  schemaVersion: 1,
  protocolVersion: PROTOCOL_VERSION,
  platform: 'win32',
  arch: ARCH,
  appVersion:
    process.env.SYRNIKE_DESKTOP_BUILD_VERSION ||
    readFileSync(path.resolve(repoRoot, 'VERSION'), 'utf8').trim(),
  releaseChannel:
    process.env.SYRNIKE_DESKTOP_CHANNEL === 'nightly' ? 'nightly' : 'stable',
  commitSha,
  electronVersion,
  napiVersion: NAPI_VERSION,
  capabilities: ['lifecycle'],
  limits: {
    controlQueue: 16,
    eventQueue: 64,
    startDeadlineMs: 2000,
    pingDeadlineMs: 1000,
    shutdownDeadlineMs: 1000,
  },
  files: MEDIA_FILES.map((name) => ({
    name,
    sha256: sha256(sources.get(name)),
  })),
}

stageArtifacts(distRoot, sources, manifest)
stageArtifacts(desktopStageRoot, sources, manifest)
console.info(`[windows-media-engine] staged lifecycle addon for Electron ${electronVersion}`)

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
        ? { PATH: `${windowsCmakeBin}${path.delimiter}${process.env.PATH ?? ''}` }
        : {}),
    },
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function requiredFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Required media engine artifact was not built: ${filePath}`)
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
    throw new Error('Cannot determine the media engine commit')
  }
  return result.stdout.trim()
}

function resolveWindowsCmakeBin() {
  if (process.platform !== 'win32') return undefined
  const candidates = [
    'C:/Program Files/Microsoft Visual Studio/18/Community/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin',
    'C:/Program Files/Microsoft Visual Studio/18/Enterprise/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin',
    'C:/Program Files/CMake/bin',
  ]
  return candidates.find((candidate) => existsSync(path.resolve(candidate, 'cmake.exe')))
}

function stageArtifacts(targetRoot, sourceFiles, manifest) {
  rmSync(targetRoot, { recursive: true, force: true })
  mkdirSync(targetRoot, { recursive: true })
  for (const [name, source] of sourceFiles) copyFileSync(source, path.resolve(targetRoot, name))
  writeFileSync(
    path.resolve(targetRoot, 'media-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  )
}
