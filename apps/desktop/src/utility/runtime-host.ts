import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import {
  createNativeDiagnosticLog,
  type NativeDiagnosticLog,
} from '../main/native-runtime/diagnostic-log'
import {
  NATIVE_RUNTIME_CONTRACT_VERSION,
  isNativeRuntimeRequest,
  isNativeRuntimeEvent,
  isNativeRuntimeReply,
  nativeRuntimeError,
  sanitizeRuntimeError,
  type NativeRuntimeEvent,
  type NativeRuntimeKind,
  type NativeRuntimeReply,
} from '../main/native-runtime/contract'
import {
  NATIVE_RUNTIME_LIVEKIT_VERSION,
  verifyNativeArtifactDistribution,
} from '../main/native-runtime/native-artifacts'

type ParentPort = {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: unknown): void
}

const parentPort = process.parentPort as ParentPort | undefined

type NativeRuntimeInstance = {
  ready?(): Promise<void>
  dispatch(command: Record<string, unknown>): void
  shutdown(): void | Promise<void>
}

type NativeRuntimeAddon = {
  createMediaRuntime?: (
    emit: (event: Record<string, unknown>) => void,
  ) => NativeRuntimeInstance
  createHotkeyRuntime?: (emit: (event: Record<string, unknown>) => void) => NativeRuntimeInstance
  createOverlayRuntime?: (emit: (event: Record<string, unknown>) => void) => NativeRuntimeInstance
  getRuntimeInfo?: () => {
    runtime?: string
    contractVersion?: number
    capabilities?: string[]
    commit?: string
    napi?: string
    livekit?: string
    diagnosticsEnabled?: boolean
  }
}

const REQUIRED_CAPABILITIES: Record<NativeRuntimeKind, readonly string[]> = {
  media: [
    'microphone',
    'screen',
    'screenAudio',
    'preview',
    'queries',
    'remoteVideo',
    'localScreenPreview',
  ],
  hotkey: ['hotkeys'],
  overlay: ['overlay'],
}

function isNativeReplyEvent(
  value: Record<string, unknown>,
): value is Record<string, unknown> & NativeRuntimeReply {
  return (
    value.type === 'reply' &&
    typeof value.requestId === 'string' &&
    typeof value.ok === 'boolean'
  )
}

function postReply(
  parentPort: ParentPort,
  requestId: string,
  error: unknown,
) {
  const detail = sanitizeDispatchError(error)
  parentPort.postMessage({
    type: 'reply',
    requestId,
    ok: false,
    error: detail,
  } satisfies NativeRuntimeReply)
}

function sanitizeDispatchError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/\bqueue[_ -]?full\b/i.test(message)) {
    return nativeRuntimeError('queue_full', 'Native runtime command queue is full', {
      retryable: true,
    })
  }
  return sanitizeRuntimeError(error)
}

export async function runNativeUtilityHost(runtimeKind: NativeRuntimeKind) {
  if (!parentPort) {
    throw new Error('Native utility host has no Electron parent port')
  }
  const diagnosticLog = createUtilityDiagnosticLog(runtimeKind)
  diagnosticLog?.log('utility_startup', {
    pid: process.pid,
    runtimeKind,
    nativeLogConfigured: Boolean(process.env.SYRNIKE_NATIVE_MEDIA_LOG_PATH),
  })

  const nativeModulePath = process.env.SYRNIKE_NATIVE_MODULE_PATH
  const nativeRoot = process.env.SYRNIKE_NATIVE_ROOT
  const expectedModuleName = `syrnike_${runtimeKind}.node`
  if (
    !nativeModulePath ||
    !nativeRoot ||
    !path.isAbsolute(nativeModulePath) ||
    !path.isAbsolute(nativeRoot) ||
    path.dirname(nativeModulePath) !== nativeRoot ||
    path.basename(nativeModulePath) !== expectedModuleName ||
    !existsSync(nativeModulePath)
  ) {
    diagnosticLog?.log('startup_validation_failed', {
      reason: 'invalid_native_module_environment',
      runtimeKind,
      nativeModuleFile:
        typeof nativeModulePath === 'string' ? path.basename(nativeModulePath) : undefined,
    })
    postIncompatibleReady(parentPort, runtimeKind)
    await diagnosticLog?.close()
    return
  }

  const releaseChannel = process.env.SYRNIKE_NATIVE_RELEASE_CHANNEL
  const appVersion = process.env.SYRNIKE_NATIVE_APP_VERSION
  const expectedContractVersion = Number(
    process.env.SYRNIKE_NATIVE_CONTRACT_VERSION,
  )
  const expectedLiveKitVersion = process.env.SYRNIKE_NATIVE_LIVEKIT_VERSION
  const expectedCommitSha = process.env.SYRNIKE_NATIVE_COMMIT_SHA
  if (
    !appVersion ||
    (releaseChannel !== 'stable' && releaseChannel !== 'nightly') ||
    expectedContractVersion !== NATIVE_RUNTIME_CONTRACT_VERSION ||
    expectedLiveKitVersion !== NATIVE_RUNTIME_LIVEKIT_VERSION ||
    !expectedCommitSha ||
    !/^[0-9a-f]{40}$/i.test(expectedCommitSha)
  ) {
    diagnosticLog?.log('startup_validation_failed', {
      reason: 'invalid_runtime_metadata_environment',
      runtimeKind,
    })
    postIncompatibleReady(parentPort, runtimeKind)
    await diagnosticLog?.close()
    return
  }

  let manifest: ReturnType<typeof verifyNativeArtifactDistribution>
  try {
    manifest = verifyNativeArtifactDistribution(nativeRoot, {
      appVersion,
      commitSha: expectedCommitSha,
      contractVersion: NATIVE_RUNTIME_CONTRACT_VERSION,
      electronVersion: process.versions.electron,
      minimumNapiVersion: Number(process.versions.napi ?? 0),
      liveKitVersion: NATIVE_RUNTIME_LIVEKIT_VERSION,
      releaseChannel,
    })
  } catch (error) {
    diagnosticLog?.log('startup_validation_failed', {
      reason: 'artifact_distribution_verification_failed',
      runtimeKind,
      error: error instanceof Error ? error.message : String(error),
    })
    postIncompatibleReady(parentPort, runtimeKind)
    await diagnosticLog?.close()
    return
  }

  const require = createRequire(path.resolve(process.cwd(), 'syrnike-utility-host.cjs'))
  let addon: NativeRuntimeAddon
  try {
    addon = require(nativeModulePath) as NativeRuntimeAddon
    diagnosticLog?.log('addon_loaded', {
      nativeModuleFile: path.basename(nativeModulePath),
    })
  } catch {
    diagnosticLog?.log('addon_load_failed', {
      nativeModuleFile: path.basename(nativeModulePath),
    })
    postIncompatibleReady(parentPort, runtimeKind)
    await diagnosticLog?.close()
    return
  }
  let info: ReturnType<NonNullable<NativeRuntimeAddon['getRuntimeInfo']>> = {}
  try {
    info = addon.getRuntimeInfo?.() ?? {}
    diagnosticLog?.log('addon_runtime_info', {
      nativeDiagnosticsEnabled: info.diagnosticsEnabled === true,
    })
  } catch {
    diagnosticLog?.log('addon_info_failed')
    postIncompatibleReady(parentPort, runtimeKind)
    await diagnosticLog?.close()
    return
  }
  const factory = runtimeKind === 'media'
    ? addon.createMediaRuntime
    : runtimeKind === 'hotkey'
      ? addon.createHotkeyRuntime
      : addon.createOverlayRuntime

  let runtime: NativeRuntimeInstance | null = null
  let shutdownRequestId: string | null = null
  let shuttingDown = false
  let contractCorrupted = false
  const shutdown = (exitCode = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    diagnosticLog?.log('utility_shutdown', {
      exitCode,
      runtimeWasActive: Boolean(runtime),
      shutdownRequestId,
    })
    const current = runtime
    runtime = null
    void Promise.resolve()
      .then(() => current?.shutdown())
      .then(() => diagnosticLog?.close())
      .then(
        () => process.exit(exitCode),
        () => process.exit(1),
      )
  }
  const failContractCorruption = () => {
    if (contractCorrupted) return
    contractCorrupted = true
    diagnosticLog?.log('native_contract_corruption', {
      runtimeKind,
      runtimeWasActive: Boolean(runtime),
    })
    parentPort.postMessage({
      type: 'event',
      event: {
        type: 'runtimeError',
        sequence: 0,
        error: nativeRuntimeError(
          'invalid_native_event',
          'Native runtime emitted an invalid event',
        ),
      } satisfies NativeRuntimeEvent,
    })
    setTimeout(() => process.exit(1), 2_000)
    shutdown(1)
  }
  const emit = (rawEvent: Record<string, unknown>) => {
    if (isNativeReplyEvent(rawEvent)) {
      if (!isNativeRuntimeReply(rawEvent)) {
        failContractCorruption()
        return
      }
      diagnosticLog?.log('native_reply', rawEvent)
      const reply = rawEvent.ok
        ? rawEvent
        : { ...rawEvent, error: sanitizeRuntimeError(rawEvent.error) }
      parentPort.postMessage(reply)
      if (rawEvent.requestId === shutdownRequestId) shutdown()
      return
    }
    if (!isNativeRuntimeEvent(rawEvent)) {
      failContractCorruption()
      return
    }
    if (rawEvent.type !== 'microphoneMetrics') {
      diagnosticLog?.log('native_event', rawEvent)
    }
    parentPort.postMessage({ type: 'event', event: rawEvent })
  }

  const actualRuntime =
    info.runtime === 'media' || info.runtime === 'hotkey' || info.runtime === 'overlay'
      ? info.runtime
      : 'invalid'
  const reportedContractVersion = Number.isSafeInteger(info.contractVersion)
    ? Number(info.contractVersion)
    : 0
  const capabilitiesValid =
    Array.isArray(info.capabilities) &&
    info.capabilities.length <= 32 &&
    info.capabilities.every(
      (capability) =>
        typeof capability === 'string' &&
        capability.length > 0 &&
        capability.length <= 128,
    )
  const capabilitiesMatch =
    capabilitiesValid &&
    REQUIRED_CAPABILITIES[runtimeKind].every((capability) =>
      info.capabilities!.includes(capability),
    )
  const reportedCommit =
    typeof info.commit === 'string' ? info.commit : undefined
  const reportedNapi = typeof info.napi === 'string' ? info.napi : undefined
  const reportedLiveKit =
    typeof info.livekit === 'string' ? info.livekit : undefined
  const contractVersion = capabilitiesMatch
    ? reportedContractVersion
    : 0
  const addonNapiVersion = Number(reportedNapi)
  const buildMatches =
    reportedCommit === manifest.commitSha &&
    addonNapiVersion === manifest.napiVersion &&
    (runtimeKind !== 'media' || reportedLiveKit === manifest.liveKitVersion)
  const ready = {
    type: 'ready',
    contractVersion:
      buildMatches && actualRuntime !== 'invalid' ? contractVersion : 0,
    // `invalid` is an explicit handshake sentinel, not a fallback to the
    // expected kind. Main can therefore report the real mismatch immediately.
    runtime: actualRuntime,
    capabilities: capabilitiesValid ? info.capabilities! : [],
    build: {
      commit: reportedCommit,
      electron: process.versions.electron,
      napi: reportedNapi,
      livekit: reportedLiveKit,
    },
  } as const

  if (
    actualRuntime !== runtimeKind ||
    !buildMatches ||
    !capabilitiesMatch ||
    contractVersion !== NATIVE_RUNTIME_CONTRACT_VERSION
  ) {
    diagnosticLog?.log('utility_ready_incompatible', ready)
    parentPort.postMessage(ready)
    await diagnosticLog?.close()
    return
  }

  if (!factory) {
    diagnosticLog?.log('startup_validation_failed', {
      reason: 'missing_runtime_factory',
      runtimeKind,
    })
    postIncompatibleReady(parentPort, runtimeKind)
    await diagnosticLog?.close()
    return
  }
  runtime = factory(emit)
  process.once('disconnect', shutdown)
  process.once('SIGTERM', shutdown)
  try {
    await runtime.ready?.()
  } catch {
    diagnosticLog?.log('runtime_ready_failed')
    shutdown(1)
    return
  }
  if (shuttingDown) return
  diagnosticLog?.log('utility_ready', ready)
  parentPort.postMessage({
    ...ready,
  })

  parentPort.on('message', (messageEvent: { data: unknown }) => {
    const request = messageEvent.data
    if (!isNativeRuntimeRequest(request)) return
    diagnosticLog?.log('incoming_dispatch', request)
    try {
      if (request.command.type === 'shutdown') {
        shutdownRequestId = request.requestId
      }
      runtime?.dispatch({
        ...request.command,
        requestId: request.requestId,
      })
    } catch (error) {
      diagnosticLog?.log('dispatch_failed', {
        requestId: request.requestId,
        error: sanitizeDispatchError(error),
      })
      postReply(parentPort, request.requestId, error)
      if (request.requestId === shutdownRequestId) shutdown()
    }
  })
}

function postIncompatibleReady(
  port: ParentPort,
  runtime: NativeRuntimeKind,
) {
  port.postMessage({
    type: 'ready',
    contractVersion: 0,
    runtime,
    capabilities: [],
    build: {
      electron: process.versions.electron,
      napi: process.versions.napi,
    },
  })
}

function createUtilityDiagnosticLog(
  runtime: NativeRuntimeKind,
): NativeDiagnosticLog | null {
  const runId = process.env.SYRNIKE_NATIVE_DIAGNOSTIC_RUN_ID
  const filePath = process.env.SYRNIKE_NATIVE_UTILITY_LOG_PATH
  if (runtime !== 'media' || !runId || !filePath) return null
  return createNativeDiagnosticLog({
    runtime,
    role: 'utility',
    runId,
    directory: path.dirname(filePath),
    filePath,
  })
}
