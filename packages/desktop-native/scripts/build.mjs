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
const CONTRACT_VERSION = 3
const LIVEKIT_REVISION = '7596552cdba189fd908c8daa1b55c353efd015a3'
const LIVEKIT_RUST_REVISION = 'dad794d414fda9e8c1de83af1c0f190506a15f8f'
const NAPI_VERSION = 8
const ARCH = 'x64'
const NATIVE_FILES = [
  'syrnike_media.node',
  'syrnike_hotkey.node',
  'syrnike_overlay.node',
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
const vcpkgRoot = resolveVcpkgRoot()
const windowsCmakeBin = resolveWindowsCmakeBin()
const windowsLibclangPath = resolveWindowsLibclangPath()
if (
  process.platform === 'win32' &&
  !process.env.LIBCLANG_PATH &&
  !windowsLibclangPath
) {
  throw new Error(
    'libclang.dll is required for the native LiveKit build. Install the Visual Studio LLVM/Clang component or set LIBCLANG_PATH to the directory containing libclang.dll.',
  )
}
const rustTargetRoot = process.env.SYRNIKE_LIVEKIT_RUST_TARGET_DIR
  ? path.resolve(process.env.SYRNIKE_LIVEKIT_RUST_TARGET_DIR)
  : resolveDefaultRustTargetRoot()

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
const buildCommitSha = process.env.GITHUB_SHA || gitCommitSha()
const expectedBuildConfiguration = JSON.stringify(
  {
    arch: ARCH,
    electronVersion,
    liveKitRevision: LIVEKIT_REVISION,
    liveKitRustRevision: LIVEKIT_RUST_REVISION,
    liveKitVersion: LIVEKIT_VERSION,
    napiVersion: NAPI_VERSION,
    rustTargetRoot,
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

// CMake caches configure-time values. Refresh the commit definition explicitly
// so an incremental build after a commit cannot stage addons whose embedded
// metadata belongs to the previous HEAD.
if (existsSync(cmakeCacheFile)) {
  run('pnpm', [
    'exec',
    'cmake',
    '-S',
    nativeRoot,
    '-B',
    buildRoot,
    `-DSYRNIKE_NATIVE_COMMIT=${buildCommitSha}`,
  ])
}

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
  `--CDCMAKE_TOOLCHAIN_FILE=${path.resolve(vcpkgRoot, 'scripts', 'buildsystems', 'vcpkg.cmake')}`,
  '--CDVCPKG_TARGET_TRIPLET=x64-windows-static-md',
  '--CDVCPKG_HOST_TRIPLET=x64-windows-static-md',
  `--CDVCPKG_MANIFEST_DIR=${path.resolve(packageRoot, 'vendor', 'livekit-client')}`,
  `--CDVCPKG_INSTALLED_DIR=${path.resolve(buildRoot, '_deps', 'vcpkg_installed')}`,
  `--CDLIVEKIT_RUST_TARGET_DIR=${rustTargetRoot}`,
  `--CDNAPI_VERSION=${NAPI_VERSION}`,
  `--CDSYRNIKE_ENABLE_ASAN=${enableAsan ? 'ON' : 'OFF'}`,
  `--CDSYRNIKE_NATIVE_COMMIT=${buildCommitSha}`,
])

writeFileSync(buildConfigurationFile, `${expectedBuildConfiguration}\n`, 'utf8')

if (!shouldStage) {
  console.info(`[desktop-native] ${configuration} build completed without staging`)
  process.exit(0)
}

const liveKitBinRoot = path.resolve(buildRoot, configuration)
const liveKitFfiRoot = path.resolve(
  rustTargetRoot,
  configuration === 'Debug' ? 'debug' : 'release',
)
const sources = new Map([
  [
    'syrnike_media.node',
    requiredFile(path.resolve(buildRoot, configuration, 'syrnike_media.node')),
  ],
  [
    'syrnike_hotkey.node',
    requiredFile(path.resolve(buildRoot, configuration, 'syrnike_hotkey.node')),
  ],
  [
    'syrnike_overlay.node',
    requiredFile(path.resolve(buildRoot, configuration, 'syrnike_overlay.node')),
  ],
  ['livekit.dll', requiredFile(path.resolve(liveKitBinRoot, 'livekit.dll'))],
  [
    'livekit_ffi.dll',
    requiredFile(path.resolve(liveKitFfiRoot, 'livekit_ffi.dll')),
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
  commitSha: buildCommitSha,
  electronVersion,
  napiVersion: NAPI_VERSION,
  liveKitVersion: LIVEKIT_VERSION,
  liveKitRevision: LIVEKIT_REVISION,
  liveKitRustRevision: LIVEKIT_RUST_REVISION,
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
  const useDirectPnpmLauncher = process.platform === 'win32' && command === 'pnpm'
  if (useDirectPnpmLauncher && !process.env.npm_execpath) {
    throw new Error('npm_execpath is required to launch pnpm without cmd.exe')
  }
  const pnpmLauncher = useDirectPnpmLauncher ? process.env.npm_execpath : undefined
  const pnpmLauncherIsExecutable =
    pnpmLauncher && path.extname(pnpmLauncher).toLowerCase() === '.exe'
  const executable = pnpmLauncherIsExecutable
    ? pnpmLauncher
    : useDirectPnpmLauncher
      ? process.execPath
      : command
  const spawnArgs = pnpmLauncherIsExecutable
    ? commandArgs
    : useDirectPnpmLauncher
      ? [pnpmLauncher, ...commandArgs]
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
      ...(windowsLibclangPath && !process.env.LIBCLANG_PATH
        ? { LIBCLANG_PATH: windowsLibclangPath }
        : {}),
      // A clean webrtc-sys build launches many memory-heavy MSVC frontends.
      // Capping Cargo's jobserver keeps a 32 GB development machine responsive
      // and prevents cl.exe processes from being terminated under memory pressure.
      ...(process.platform === 'win32' && !process.env.CARGO_BUILD_JOBS
        ? { CARGO_BUILD_JOBS: '3' }
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

function resolveVcpkgRoot() {
  const candidates = [
    process.env.VCPKG_ROOT,
    process.env.VCPKG_INSTALLATION_ROOT,
    'C:/PROGRA~1/MICROS~2/18/COMMUN~1/VC/vcpkg',
    'C:/PROGRA~1/MICROS~2/18/ENTERP~1/VC/vcpkg',
    'C:/PROGRA~1/MICROS~2/2022/COMMUN~1/VC/vcpkg',
    'C:/PROGRA~1/MICROS~2/2022/ENTERP~1/VC/vcpkg',
    'C:/Program Files/Microsoft Visual Studio/2022/Community/VC/vcpkg',
    'C:/Program Files/Microsoft Visual Studio/2022/Enterprise/VC/vcpkg',
  ].filter(Boolean)
  const root = candidates.find((candidate) =>
    existsSync(path.resolve(candidate, 'scripts', 'buildsystems', 'vcpkg.cmake')),
  )
  if (!root) {
    throw new Error('A vcpkg installation is required to build the vendored LiveKit SDK')
  }
  return root
}

function resolveWindowsCmakeBin() {
  if (process.platform !== 'win32') return undefined
  const candidates = [
    'C:/Program Files/Microsoft Visual Studio/18/Community/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin',
    'C:/Program Files/Microsoft Visual Studio/18/Enterprise/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin',
  ]
  return candidates.find((candidate) => existsSync(path.resolve(candidate, 'cmake.exe')))
}

function resolveWindowsLibclangPath() {
  if (process.platform !== 'win32' || process.env.LIBCLANG_PATH) return undefined
  const workspaceDriveRoot = path.parse(repoRoot).root
  const candidates = [
    'C:/Program Files/Microsoft Visual Studio/18/Community/VC/Tools/Llvm/x64/bin',
    'C:/Program Files/Microsoft Visual Studio/18/Enterprise/VC/Tools/Llvm/x64/bin',
    'C:/Program Files/Microsoft Visual Studio/18/Professional/VC/Tools/Llvm/x64/bin',
    'C:/Program Files/LLVM/bin',
    // The bootstrap used on Windows workstations installs Python's libclang
    // into a short, non-synchronised path on the workspace drive. Keep this
    // after the standard toolchain locations so a Visual Studio installation
    // remains the preferred source when its LLVM component is present.
    path.resolve(
      workspaceDriveRoot,
      'syrnike-build-tools',
      'python-libclang',
      'clang',
      'native',
    ),
    ...(process.env.PATH ?? '').split(path.delimiter),
  ].filter(Boolean)
  return candidates.find((candidate) =>
    existsSync(path.resolve(candidate, 'libclang.dll')),
  )
}

function resolveDefaultRustTargetRoot() {
  if (process.platform !== 'win32') return path.resolve(buildRoot, 'rust-target')
  const secondaryDriveCache = 'G:/syrnike13-build-cache/livekit-rust-target'
  if (existsSync(secondaryDriveCache)) return path.resolve(secondaryDriveCache)

  // Keep the Cargo target outside the checkout and close to the drive root.
  // libwebrtc's generated include tree is deep enough that an AppData-based
  // target path exceeds the path length accepted by cl.exe on clean builds.
  const workspaceDriveRoot = path.parse(repoRoot).root
  return path.resolve(
    workspaceDriveRoot,
    'syrnike13-build-cache',
    'livekit-rust-target',
  )
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
