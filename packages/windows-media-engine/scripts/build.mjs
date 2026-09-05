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

const NAPI_VERSION = 8
const ARCH = 'x64'
const MEDIA_FILES = ['windows_media.node', 'livekit.dll', 'livekit_ffi.dll']

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(packageRoot, '..', '..')
const args = new Set(process.argv.slice(2))
const checkProtocol = args.has('--check-protocol')
const generateProtocolOnly = args.has('--generate-protocol-only')
const staleGeneratedFiles = []
const protocolSpecPath = path.resolve(packageRoot, 'protocol', 'media-lifecycle.json')
const protocolSpecSource = readFileSync(protocolSpecPath, 'utf8')
const protocolSpec = JSON.parse(protocolSpecSource)
const PROTOCOL_SCHEMA_SHA256 = createHash('sha256')
  .update(protocolSpecSource)
  .digest('hex')
const PROTOCOL_VERSION = protocolSpec.version
const UTILITY_BOOTSTRAP_MESSAGE = protocolSpec.electron.utilityBootstrapMessage
const CONTROL_QUEUE_CAPACITY = protocolSpec.limits.controlQueueCapacity
const EVENT_QUEUE_CAPACITY = protocolSpec.limits.eventQueueCapacity
const MAX_CREDENTIAL_LEASES = protocolSpec.limits.maximumCredentialLeases
const MAX_REQUEST_ID_LENGTH = protocolSpec.limits.maximumRequestIdLength
const MAX_IDENTIFIER_LENGTH = protocolSpec.limits.maximumIdentifierLength
const MAX_SERVER_URL_LENGTH = protocolSpec.limits.maximumServerUrlLength
const MAX_ACCESS_TOKEN_LENGTH = protocolSpec.limits.maximumAccessTokenLength
const MAX_REMOTE_VIDEO_DEMANDS = protocolSpec.limits.maximumRemoteVideoDemands
const MAX_DIAGNOSTIC_METRICS = protocolSpec.limits.maximumDiagnosticMetrics
const MAX_DIAGNOSTIC_FIELDS = protocolSpec.limits.maximumDiagnosticFields
const MAX_DIAGNOSTIC_NAME_LENGTH = protocolSpec.limits.maximumDiagnosticNameLength
const MAX_DIAGNOSTIC_VALUE_LENGTH = protocolSpec.limits.maximumDiagnosticValueLength
const MAX_FAILURE_CODE_LENGTH = protocolSpec.limits.maximumFailureCodeLength
const MAX_FAILURE_MESSAGE_LENGTH = protocolSpec.limits.maximumFailureMessageLength
const MAX_FAILURE_STAGE_LENGTH = protocolSpec.limits.maximumFailureStageLength
const MAX_REQUEST_DEADLINE_MS = protocolSpec.limits.maximumRequestDeadlineMs
const ROOM_CONNECT_DEADLINE_MS = protocolSpec.limits.roomConnectDeadlineMs
const ROOM_DISCONNECT_DEADLINE_MS = protocolSpec.limits.roomDisconnectDeadlineMs
const ROOM_CANCELLATION_DEADLINE_MS = protocolSpec.limits.roomCancellationDeadlineMs
const START_DEADLINE_MS = protocolSpec.limits.startDeadlineMs
const PING_DEADLINE_MS = protocolSpec.limits.pingDeadlineMs
const SHUTDOWN_DEADLINE_MS = protocolSpec.limits.shutdownDeadlineMs
const nativeRoot = path.resolve(packageRoot, 'native')
generateProtocolHeader()
generateTypeScriptProtocolIdentity()
if (staleGeneratedFiles.length > 0) {
  throw new Error(
    `Generated media protocol files are stale: ${staleGeneratedFiles.join(', ')}. Run pnpm --filter @syrnike13/windows-media-engine protocol:generate.`,
  )
}
if (checkProtocol || generateProtocolOnly) {
  console.info(
    checkProtocol
      ? '[windows-media-engine] generated protocol files are current'
      : '[windows-media-engine] generated protocol files updated',
  )
  process.exit(0)
}
const buildRoot = path.resolve(
  packageRoot,
  process.env.WINDOWS_MEDIA_BUILD_ROOT || 'build',
)
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

const configIndex = process.argv.indexOf('--config')
const configuration = configIndex >= 0 ? process.argv[configIndex + 1] : 'Release'
const shouldStage = !args.has('--no-stage') && configuration === 'Release'
const enableAsan = args.has('--asan')
const buildMediaLab = args.has('--lab')

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
  `--CDWINDOWS_MEDIA_BUILD_LAB=${buildMediaLab ? 'ON' : 'OFF'}`,
  `--CDWINDOWS_MEDIA_LIVEKIT_SDK_ROOT=${
    buildMediaLab ? process.env.MEDIA_LAB_LIVEKIT_SDK_ROOT ?? '' : ''
  }`,
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
  protocolSchemaSha256: PROTOCOL_SCHEMA_SHA256,
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
  capabilities: ['lifecycle', 'control-v3', 'diagnostics-v2'],
  limits: {
    controlQueue: CONTROL_QUEUE_CAPACITY,
    eventQueue: EVENT_QUEUE_CAPACITY,
    roomConnectDeadlineMs: ROOM_CONNECT_DEADLINE_MS,
    roomDisconnectDeadlineMs: ROOM_DISCONNECT_DEADLINE_MS,
    roomCancellationDeadlineMs: ROOM_CANCELLATION_DEADLINE_MS,
    startDeadlineMs: START_DEADLINE_MS,
    pingDeadlineMs: PING_DEADLINE_MS,
    shutdownDeadlineMs: SHUTDOWN_DEADLINE_MS,
    maxIdentifierLength: MAX_IDENTIFIER_LENGTH,
    maxRemoteVideoDemands: MAX_REMOTE_VIDEO_DEMANDS,
    maxDiagnosticMetrics: MAX_DIAGNOSTIC_METRICS,
    maxDiagnosticFields: MAX_DIAGNOSTIC_FIELDS,
    maxRequestDeadlineMs: MAX_REQUEST_DEADLINE_MS,
  },
  files: MEDIA_FILES.map((name) => ({
    name,
    sha256: sha256(sources.get(name)),
  })),
}

stageArtifacts(distRoot, sources, manifest)
stageArtifacts(desktopStageRoot, sources, manifest)
console.info(`[windows-media-engine] staged lifecycle addon for Electron ${electronVersion}`)

function generateProtocolHeader() {
  const target = path.resolve(
    nativeRoot,
    'src',
    'core',
    'protocol_limits.generated.hpp',
  )
  const content = `#pragma once

// clang-format off
#include <cstddef>
#include <cstdint>
#include <array>
#include <string_view>

// Generated by scripts/build.mjs from protocol/media-lifecycle.json.
namespace syrnike::windows_media::protocol {

inline constexpr int kVersion = ${PROTOCOL_VERSION};
inline constexpr std::string_view kSchemaSha256 = "${PROTOCOL_SCHEMA_SHA256}";
inline constexpr std::size_t kControlQueueCapacity = ${CONTROL_QUEUE_CAPACITY};
inline constexpr std::size_t kEventQueueCapacity = ${EVENT_QUEUE_CAPACITY};
inline constexpr std::size_t kMaximumCredentialLeases = ${MAX_CREDENTIAL_LEASES};
inline constexpr std::size_t kMaximumRequestIdLength = ${MAX_REQUEST_ID_LENGTH};
inline constexpr std::size_t kMaximumIdentifierLength = ${MAX_IDENTIFIER_LENGTH};
inline constexpr std::size_t kMaximumServerUrlLength = ${MAX_SERVER_URL_LENGTH};
inline constexpr std::size_t kMaximumAccessTokenLength = ${MAX_ACCESS_TOKEN_LENGTH};
inline constexpr std::size_t kMaximumRemoteVideoDemands = ${MAX_REMOTE_VIDEO_DEMANDS};
inline constexpr std::size_t kMaximumDiagnosticMetrics = ${MAX_DIAGNOSTIC_METRICS};
inline constexpr std::size_t kMaximumDiagnosticFields = ${MAX_DIAGNOSTIC_FIELDS};
inline constexpr std::size_t kMaximumDiagnosticNameLength = ${MAX_DIAGNOSTIC_NAME_LENGTH};
inline constexpr std::size_t kMaximumDiagnosticValueLength = ${MAX_DIAGNOSTIC_VALUE_LENGTH};
inline constexpr std::size_t kMaximumFailureCodeLength = ${MAX_FAILURE_CODE_LENGTH};
inline constexpr std::size_t kMaximumFailureMessageLength = ${MAX_FAILURE_MESSAGE_LENGTH};
inline constexpr std::size_t kMaximumFailureStageLength = ${MAX_FAILURE_STAGE_LENGTH};
inline constexpr std::uint32_t kMaximumRequestDeadlineMs = ${MAX_REQUEST_DEADLINE_MS};
inline constexpr std::uint32_t kRoomConnectDeadlineMs = ${ROOM_CONNECT_DEADLINE_MS};
inline constexpr std::uint32_t kRoomDisconnectDeadlineMs = ${ROOM_DISCONNECT_DEADLINE_MS};
inline constexpr std::uint32_t kRoomCancellationDeadlineMs = ${ROOM_CANCELLATION_DEADLINE_MS};
inline constexpr std::uint32_t kStartDeadlineMs = ${START_DEADLINE_MS};
inline constexpr std::uint32_t kPingDeadlineMs = ${PING_DEADLINE_MS};
inline constexpr std::uint32_t kShutdownDeadlineMs = ${SHUTDOWN_DEADLINE_MS};

namespace fields {
${Object.entries(protocolSpec.fields).map(([name, fields]) =>
  `inline constexpr std::array<std::string_view, ${fields.length}> k${name[0].toUpperCase()}${name.slice(1)} = { ${fields.map((field) => `"${field}"`).join(', ')} };`,
).join('\n')}
}  // namespace fields

namespace event_fields {
${Object.entries(protocolSpec.eventFields).flatMap(([name, fields]) =>
  ['required', 'optional'].map((kind) => {
    const values = fields[kind]
    const constant = `k${name[0].toUpperCase()}${name.slice(1)}${kind[0].toUpperCase()}${kind.slice(1)}`
    return `inline constexpr std::array<std::string_view, ${values.length}> ${constant} = { ${values.map((field) => `"${field}"`).join(', ')} };`
  }),
).join('\n')}
}  // namespace event_fields

}  // namespace syrnike::windows_media::protocol
// clang-format on
`
  syncGeneratedFile(target, content)
}

function generateTypeScriptProtocolIdentity() {
  const target = path.resolve(
    repoRoot,
    'apps',
    'desktop',
    'src',
    'main',
    'media-runtime',
    'protocol.generated.ts',
  )
  const content = `// Generated by packages/windows-media-engine/scripts/build.mjs.\n` +
    `export const MEDIA_LIFECYCLE_GENERATED_VERSION = ${PROTOCOL_VERSION} as const\n` +
    `export const MEDIA_UTILITY_GENERATED_BOOTSTRAP_MESSAGE = ${JSON.stringify(UTILITY_BOOTSTRAP_MESSAGE)} as const\n` +
    `export const MEDIA_LIFECYCLE_SCHEMA_SHA256 = '${PROTOCOL_SCHEMA_SHA256}' as const\n` +
    `// prettier-ignore\nexport const MEDIA_LIFECYCLE_PROTOCOL_LIMITS = ${JSON.stringify(protocolSpec.limits)} as const\n` +
    `// prettier-ignore\nexport const MEDIA_LIFECYCLE_PROTOCOL_FIELDS = ${JSON.stringify(protocolSpec.fields)} as const\n` +
    `// prettier-ignore\nexport const MEDIA_LIFECYCLE_EVENT_FIELDS = ${JSON.stringify(protocolSpec.eventFields)} as const\n` +
    `// prettier-ignore\nexport const MEDIA_LIFECYCLE_PROTOCOL_COMMANDS = ${JSON.stringify(protocolSpec.commands)} as const\n` +
    `// prettier-ignore\nexport const MEDIA_LIFECYCLE_PROTOCOL_RESULTS = ${JSON.stringify(protocolSpec.results)} as const\n` +
    `// prettier-ignore\nexport const MEDIA_LIFECYCLE_PUBLIC_EVENTS = ${JSON.stringify(protocolSpec.publicEvents)} as const\n` +
    `// prettier-ignore\nexport const MEDIA_LIFECYCLE_ROOM_STATES = ${JSON.stringify(protocolSpec.roomStates)} as const\n` +
    `// prettier-ignore\nexport const MEDIA_LIFECYCLE_CANONICAL_FIXTURES = ${JSON.stringify(protocolSpec.canonical)} as const\n`
  syncGeneratedFile(target, content)
}

function syncGeneratedFile(target, content) {
  if (existsSync(target) && readFileSync(target, 'utf8') === content) return
  if (checkProtocol) {
    staleGeneratedFiles.push(path.relative(repoRoot, target))
    return
  }
  writeFileSync(target, content, 'utf8')
}

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
