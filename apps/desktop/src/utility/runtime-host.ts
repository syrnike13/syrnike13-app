import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { Effect, Exit, Schema } from 'effect'

import {
  createNativeDiagnosticLog,
  type NativeDiagnosticLog,
} from '../main/native-runtime/diagnostic-log'
import {
  NATIVE_RUNTIME_CONTRACT_VERSION,
  isNativeRuntimeRequest,
  isNativeRuntimeEvent,
  isNativeRuntimeReply,
  isUncorrelatedNativeRuntimeReply,
  nativeRuntimeError,
  sanitizeRuntimeError,
  type NativeRuntimeEvent,
  type NativeRuntimeKind,
  type NativeRuntimeRequest,
  type NativeRuntimeReply,
} from '../main/native-runtime/contract'
import {
  NATIVE_RUNTIME_LIVEKIT_VERSION,
  type NativeArtifactManifest,
  type NativeArtifactExpectations,
  verifyNativeArtifactDistribution,
} from '../main/native-runtime/native-artifacts'

type ParentPort = {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: unknown): void
}

type UtilityCrashReporter = {
  addExtraParameter(key: string, value: string): void
}

type NativeRuntimeInstance = {
  ready?(): unknown
  dispatch(command: Record<string, unknown>): unknown
  shutdown(): unknown
}

type NativeRuntimeFactory = (
  emit: (event: Record<string, unknown>) => void,
) => unknown

type NativeRuntimeAddon = {
  createMediaRuntime?: (
    emit: (event: Record<string, unknown>) => void,
  ) => unknown
  createHotkeyRuntime?: NativeRuntimeFactory
  createOverlayRuntime?: NativeRuntimeFactory
  getRuntimeInfo?: () => unknown
}

type RuntimeHostDependencies = {
  parentPort?: ParentPort
  environment?: NodeJS.ProcessEnv
  nativeModuleExists?(nativeModulePath: string): boolean
  verifyDistribution?(
    nativeRoot: string,
    expected: NativeArtifactExpectations,
  ): NativeArtifactManifest
  loadAddon?(nativeModulePath: string): unknown
  crashReporter?: UtilityCrashReporter
  registerShutdownSignals?(shutdown: (exitCode?: number) => void): void
  exit?(exitCode: number): void
  onRuntimeCreated?(runtime: NativeRuntimeInstance): void
}

const ParentPortSchema = Schema.declare<ParentPort>(
  (input): input is ParentPort =>
    typeof input === 'object' &&
    input !== null &&
    typeof Reflect.get(input, 'on') === 'function' &&
    typeof Reflect.get(input, 'postMessage') === 'function',
)

const UtilityCrashReporterSchema = Schema.declare<UtilityCrashReporter>(
  (input): input is UtilityCrashReporter =>
    typeof input === 'object' &&
    input !== null &&
    typeof Reflect.get(input, 'addExtraParameter') === 'function',
)

const NativeRuntimeFactorySchema = Schema.declare<NativeRuntimeFactory>(
  (input): input is NativeRuntimeFactory => typeof input === 'function',
)

const RuntimeInfoFactorySchema = Schema.declare<() => unknown>(
  (input): input is () => unknown => typeof input === 'function',
)

const NativeRuntimeAddonSchema = Schema.Struct({
  createMediaRuntime: Schema.optionalKey(NativeRuntimeFactorySchema),
  createHotkeyRuntime: Schema.optionalKey(NativeRuntimeFactorySchema),
  createOverlayRuntime: Schema.optionalKey(NativeRuntimeFactorySchema),
  getRuntimeInfo: Schema.optionalKey(RuntimeInfoFactorySchema),
})

const NativeRuntimeInfoSchema = Schema.Struct({
  runtime: Schema.optionalKey(Schema.String),
  contractVersion: Schema.optionalKey(Schema.Number),
  capabilities: Schema.optionalKey(Schema.Array(Schema.String)),
  commit: Schema.optionalKey(Schema.String),
  napi: Schema.optionalKey(Schema.String),
  livekit: Schema.optionalKey(Schema.String),
  diagnosticsEnabled: Schema.optionalKey(Schema.Boolean),
})

const NativeRuntimeInstanceSchema = Schema.declare<NativeRuntimeInstance>(
  (input): input is NativeRuntimeInstance => {
    if (typeof input !== 'object' || input === null) return false
    const ready = Reflect.get(input, 'ready')
    return (
      (ready === undefined || typeof ready === 'function') &&
      typeof Reflect.get(input, 'dispatch') === 'function' &&
      typeof Reflect.get(input, 'shutdown') === 'function'
    )
  },
)

const processParentPort: unknown = Reflect.get(process, 'parentPort')
const parentPort = Schema.is(ParentPortSchema)(processParentPort)
  ? processParentPort
  : undefined

const REQUIRED_CAPABILITIES: Record<NativeRuntimeKind, readonly string[]> = {
  media: [
    'microphone',
    'screen',
    'screenAudio',
    'preview',
    'queries',
    'remoteVideo',
    'localScreenPreview',
    'localCameraPreview',
    'directRemoteAudio',
    'voiceControl',
  ],
  hotkey: ['hotkeys'],
  overlay: ['overlay'],
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

function closeDiagnosticLogEffect(diagnosticLog: NativeDiagnosticLog | null) {
  return diagnosticLog?.closeEffect() ?? Effect.void
}

export function runNativeUtilityHost(
  runtimeKind: NativeRuntimeKind,
  dependencies: RuntimeHostDependencies = {},
) {
  return Effect.runPromise(
    runNativeUtilityHostEffect(runtimeKind, dependencies),
  )
}

export const runNativeUtilityHostEffect = Effect.fn(
  'desktop.runNativeUtilityHost',
)(function*(
  runtimeKind: NativeRuntimeKind,
  dependencies: RuntimeHostDependencies = {},
) {
  const hostParentPort = dependencies.parentPort ?? parentPort
  if (!hostParentPort) {
    return yield* Effect.fail(
      new Error('Native utility host has no Electron parent port'),
    )
  }
  const environment = dependencies.environment ?? process.env
  const nativeModuleExists = dependencies.nativeModuleExists ?? existsSync
  const verifyDistribution =
    dependencies.verifyDistribution ?? verifyNativeArtifactDistribution
  const exit = dependencies.exit ?? ((exitCode: number) => process.exit(exitCode))
  const diagnosticLog = createUtilityDiagnosticLog(runtimeKind, environment)
  const processCrashReporter: unknown = Reflect.get(process, 'crashReporter')
  const utilityCrashReporter =
    dependencies.crashReporter ??
    (Schema.is(UtilityCrashReporterSchema)(processCrashReporter)
      ? processCrashReporter
      : undefined)
  const annotateCrash = (key: string, value: string | undefined) => {
    if (!utilityCrashReporter || !value) return
    try {
      utilityCrashReporter.addExtraParameter(key, value.slice(0, 127))
    } catch {
      // Missing or disabled crash reporting must not affect the native host.
    }
  }
  annotateCrash('native_runtime_kind', runtimeKind)
  annotateCrash(
    'native_runtime_run',
    environment.SYRNIKE_NATIVE_DIAGNOSTIC_RUN_ID,
  )
  annotateCrash('native_runtime_commit', environment.SYRNIKE_NATIVE_COMMIT_SHA)
  annotateCrash('native_host_stage', 'utility_startup')
  diagnosticLog?.log('utility_startup', {
    pid: process.pid,
    runtimeKind,
    nativeLogConfigured: Boolean(environment.SYRNIKE_NATIVE_MEDIA_LOG_PATH),
    architecture: process.arch,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    napiVersion: process.versions.napi,
    appVersion: environment.SYRNIKE_NATIVE_APP_VERSION,
    releaseChannel: environment.SYRNIKE_NATIVE_RELEASE_CHANNEL,
    contractVersion: environment.SYRNIKE_NATIVE_CONTRACT_VERSION,
    livekitVersion: environment.SYRNIKE_NATIVE_LIVEKIT_VERSION,
    commitSha: environment.SYRNIKE_NATIVE_COMMIT_SHA,
  })

  const nativeModulePath = environment.SYRNIKE_NATIVE_MODULE_PATH
  const nativeRoot = environment.SYRNIKE_NATIVE_ROOT
  const expectedModuleName = `syrnike_${runtimeKind}.node`
  if (
    !nativeModulePath ||
    !nativeRoot ||
    !path.isAbsolute(nativeModulePath) ||
    !path.isAbsolute(nativeRoot) ||
    path.dirname(nativeModulePath) !== nativeRoot ||
    path.basename(nativeModulePath) !== expectedModuleName ||
    !nativeModuleExists(nativeModulePath)
  ) {
    diagnosticLog?.log('startup_validation_failed', {
      reason: 'invalid_native_module_environment',
      runtimeKind,
      nativeModuleFile:
        typeof nativeModulePath === 'string' ? path.basename(nativeModulePath) : undefined,
    })
    postIncompatibleReady(hostParentPort, runtimeKind)
    yield* closeDiagnosticLogEffect(diagnosticLog)
    return
  }

  const releaseChannel = environment.SYRNIKE_NATIVE_RELEASE_CHANNEL
  const appVersion = environment.SYRNIKE_NATIVE_APP_VERSION
  const expectedContractVersion = Number(
    environment.SYRNIKE_NATIVE_CONTRACT_VERSION,
  )
  const expectedLiveKitVersion = environment.SYRNIKE_NATIVE_LIVEKIT_VERSION
  const expectedCommitSha = environment.SYRNIKE_NATIVE_COMMIT_SHA
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
    postIncompatibleReady(hostParentPort, runtimeKind)
    yield* closeDiagnosticLogEffect(diagnosticLog)
    return
  }

  const manifest = yield* Effect.try({
    try: () =>
      verifyDistribution(nativeRoot, {
        appVersion,
        commitSha: expectedCommitSha,
        contractVersion: NATIVE_RUNTIME_CONTRACT_VERSION,
        electronVersion: process.versions.electron,
        minimumNapiVersion: Number(process.versions.napi ?? 0),
        liveKitVersion: NATIVE_RUNTIME_LIVEKIT_VERSION,
        releaseChannel,
      }),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((error) =>
      Effect.gen(function*() {
        diagnosticLog?.log('startup_validation_failed', {
          reason: 'artifact_distribution_verification_failed',
          runtimeKind,
          error: error instanceof Error ? error.message : String(error),
        })
        postIncompatibleReady(hostParentPort, runtimeKind)
        yield* closeDiagnosticLogEffect(diagnosticLog)
        return null
      }),
    ),
  )
  if (!manifest) return

  const require = createRequire(path.resolve(process.cwd(), 'syrnike-utility-host.cjs'))
  const addon = yield* Effect.try({
    try: () => {
      annotateCrash('native_host_stage', 'addon_load')
      const loadedAddon: unknown = dependencies.loadAddon
        ? dependencies.loadAddon(nativeModulePath)
        : require(nativeModulePath)
      if (!Schema.is(NativeRuntimeAddonSchema)(loadedAddon)) {
        throw new TypeError('Native runtime addon has an invalid contract')
      }
      return loadedAddon
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catch(() =>
      Effect.gen(function*() {
        diagnosticLog?.log('addon_load_failed', {
          nativeModuleFile: path.basename(nativeModulePath),
        })
        postIncompatibleReady(hostParentPort, runtimeKind)
        yield* closeDiagnosticLogEffect(diagnosticLog)
        return null
      }),
    ),
  )
  if (!addon) return
  annotateCrash('native_host_stage', 'addon_loaded')
  diagnosticLog?.log('addon_loaded', {
    nativeModuleFile: path.basename(nativeModulePath),
  })
  const info = yield* Effect.try({
    try: () => {
      const runtimeInfo: unknown = addon.getRuntimeInfo?.() ?? {}
      if (!Schema.is(NativeRuntimeInfoSchema)(runtimeInfo)) {
        throw new TypeError('Native runtime info has an invalid contract')
      }
      return runtimeInfo
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catch(() =>
      Effect.gen(function*() {
        diagnosticLog?.log('addon_info_failed')
        postIncompatibleReady(hostParentPort, runtimeKind)
        yield* closeDiagnosticLogEffect(diagnosticLog)
        return null
      }),
    ),
  )
  if (!info) return
  diagnosticLog?.log('addon_runtime_info', {
    nativeDiagnosticsEnabled: info.diagnosticsEnabled === true,
  })
  const factory = runtimeKind === 'media'
    ? addon.createMediaRuntime
    : runtimeKind === 'hotkey'
      ? addon.createHotkeyRuntime
      : addon.createOverlayRuntime

  let runtime: NativeRuntimeInstance | null = null
  let shutdownRequestId: string | null = null
  let shuttingDown = false
  let contractCorrupted = false
  let boundHostEpoch: number | undefined
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
    Effect.runFork(
      Effect.gen(function*() {
        const shutdownResult = yield* Effect.exit(
          Effect.tryPromise({
            try: () => Promise.resolve(current?.shutdown()),
            catch: (cause) => cause,
          }),
        )
        const closeResult = yield* Effect.exit(
          closeDiagnosticLogEffect(diagnosticLog),
        )
        exit(
          Exit.isSuccess(shutdownResult) && Exit.isSuccess(closeResult)
            ? exitCode
            : 1,
        )
      }),
    )
  }
  const failContractCorruption = (rawEvent: Record<string, unknown>) => {
    if (contractCorrupted) return
    contractCorrupted = true
    diagnosticLog?.log('native_contract_corruption', {
      runtimeKind,
      runtimeWasActive: Boolean(runtime),
      eventType: typeof rawEvent.type === 'string' ? rawEvent.type : undefined,
    })
    hostParentPort.postMessage({
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
    setTimeout(() => exit(1), 2_000)
    shutdown(1)
  }
  const emit = (rawEvent: Record<string, unknown>) => {
    if (isUncorrelatedNativeRuntimeReply(rawEvent)) {
      diagnosticLog?.log('native_uncorrelated_reply_ignored', {
        ok: rawEvent.ok,
        error:
          rawEvent.ok === false
            ? sanitizeRuntimeError(rawEvent.error)
            : undefined,
      })
      return
    }
    if (rawEvent.type === 'reply') {
      if (!isNativeRuntimeReply(rawEvent)) {
        failContractCorruption(rawEvent)
        return
      }
      if (!rawEvent.ok) diagnosticLog?.log('native_reply', rawEvent)
      const reply = rawEvent.ok
        ? rawEvent
        : { ...rawEvent, error: sanitizeRuntimeError(rawEvent.error) }
      hostParentPort.postMessage(reply)
      if (rawEvent.requestId === shutdownRequestId) shutdown()
      return
    }
    if (!isNativeRuntimeEvent(rawEvent)) {
      if (isAdvisoryNativeRuntimeEventCandidate(rawEvent)) {
        diagnosticLog?.log('native_advisory_event_rejected', {
          runtimeKind,
          eventType: rawEvent.type,
          reason:
            typeof rawEvent.reason === 'string'
              ? rawEvent.reason.slice(0, 128)
              : undefined,
          backend:
            typeof rawEvent.backend === 'string'
              ? rawEvent.backend.slice(0, 32)
              : undefined,
        })
        return
      }
      failContractCorruption(rawEvent)
      return
    }
    if (rawEvent.type === 'sessionLifecycle' && rawEvent.kind === 'camera') {
      annotateCrash('native_camera_stage', rawEvent.state.status)
    } else if (rawEvent.type === 'cameraTerminal') {
      annotateCrash('native_camera_stage', 'terminal')
    } else if (
      rawEvent.type === 'runtimeError' &&
      rawEvent.error.stage === 'connectCamera'
    ) {
      annotateCrash('native_camera_stage', `error:${rawEvent.error.code}`)
    }
    if (shouldLogNativeRuntimeEvent(rawEvent)) {
      diagnosticLog?.log('native_event', rawEvent)
    }
    hostParentPort.postMessage({ type: 'event', event: rawEvent })
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
      ...(process.versions.electron === undefined
        ? {}
        : { electron: process.versions.electron }),
      ...(reportedCommit === undefined ? {} : { commit: reportedCommit }),
      ...(reportedNapi === undefined ? {} : { napi: reportedNapi }),
      ...(reportedLiveKit === undefined ? {} : { livekit: reportedLiveKit }),
    },
  } as const

  if (
    actualRuntime !== runtimeKind ||
    !buildMatches ||
    !capabilitiesMatch ||
    contractVersion !== NATIVE_RUNTIME_CONTRACT_VERSION
  ) {
    diagnosticLog?.log('utility_ready_incompatible', ready)
    hostParentPort.postMessage(ready)
    yield* closeDiagnosticLogEffect(diagnosticLog)
    return
  }

  if (!factory) {
    diagnosticLog?.log('startup_validation_failed', {
      reason: 'missing_runtime_factory',
      runtimeKind,
    })
    postIncompatibleReady(hostParentPort, runtimeKind)
    yield* closeDiagnosticLogEffect(diagnosticLog)
    return
  }
  annotateCrash('native_host_stage', 'runtime_create')
  const createdRuntime: unknown = yield* Effect.try({
    try: () => factory(emit),
    catch: (cause) => cause,
  })
  if (!Schema.is(NativeRuntimeInstanceSchema)(createdRuntime)) {
    diagnosticLog?.log('startup_validation_failed', {
      reason: 'invalid_runtime_instance',
      runtimeKind,
    })
    postIncompatibleReady(hostParentPort, runtimeKind)
    yield* closeDiagnosticLogEffect(diagnosticLog)
    return
  }
  runtime = createdRuntime
  dependencies.onRuntimeCreated?.(runtime)
  if (dependencies.registerShutdownSignals) {
    dependencies.registerShutdownSignals(shutdown)
  } else {
    process.once('disconnect', shutdown)
    process.once('SIGTERM', shutdown)
  }
  const runtimeReady = yield* Effect.tryPromise({
    try: () => Promise.resolve(runtime?.ready?.()),
    catch: (cause) => cause,
  }).pipe(
    Effect.match({
      onFailure: () => false,
      onSuccess: () => true,
    }),
  )
  if (!runtimeReady) {
    diagnosticLog?.log('runtime_ready_failed')
    shutdown(1)
    return
  }
  if (shuttingDown) return
  annotateCrash('native_host_stage', 'ready')
  diagnosticLog?.log('utility_ready', ready)
  hostParentPort.postMessage({
    ...ready,
  })

  const dispatchRequestEffect = Effect.fn(
    'desktop.dispatchNativeUtilityRequest',
  )(function*(request: NativeRuntimeRequest) {
    if (boundHostEpoch === undefined) {
      boundHostEpoch = request.hostEpoch
    } else if (request.hostEpoch !== boundHostEpoch) {
      diagnosticLog?.log('stale_host_epoch_rejected', {
        requestId: request.requestId,
        command: request.command.type,
        hostEpoch: request.hostEpoch,
        boundHostEpoch,
        commandStage: 'utility_dispatch',
        outcome: 'rejected',
      })
      hostParentPort.postMessage({
        type: 'reply',
        requestId: request.requestId,
        ok: false,
        error: nativeRuntimeError(
          'stale_host_epoch',
          'Native request belongs to a retired utility host epoch',
          { retryable: false },
        ),
      } satisfies NativeRuntimeReply)
      return
    }
    annotateCrash('native_last_command', request.command.type)
    annotateCrash('native_last_lane', request.lane)
    if (request.command.type === 'connectCamera') {
      annotateCrash('native_camera_stage', 'connect_dispatch')
    } else if (request.command.type === 'disconnectCamera') {
      annotateCrash('native_camera_stage', 'disconnect_dispatch')
    }
    const logDispatch = !isFrameReleaseCommand(request.command)
    if (logDispatch) diagnosticLog?.log('incoming_dispatch', request)
    if (request.command.type === 'shutdown') {
      shutdownRequestId = request.requestId
    }
    yield* Effect.try({
      try: () =>
        runtime?.dispatch({
          ...request.command,
          requestId: request.requestId,
          lane: request.lane,
          hostEpoch: request.hostEpoch,
          diagnostic: request.diagnostic,
        }),
      catch: (cause) => cause,
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          if (!logDispatch) return
          diagnosticLog?.log('dispatch_forwarded', {
            requestId: request.requestId,
            command: request.command.type,
            lane: request.lane,
            actionId: request.diagnostic?.actionId,
            operationId: request.diagnostic?.operationId,
            revision: request.diagnostic?.revision,
            hostEpoch: request.hostEpoch,
            commandStage: 'utility_dispatch',
            outcome: 'accepted',
          })
        }),
      ),
      Effect.catch((error) =>
        Effect.sync(() => {
          diagnosticLog?.log('dispatch_failed', {
            requestId: request.requestId,
            command: request.command.type,
            lane: request.lane,
            actionId: request.diagnostic?.actionId,
            operationId: request.diagnostic?.operationId,
            revision: request.diagnostic?.revision,
            hostEpoch: request.hostEpoch,
            commandStage: 'utility_dispatch',
            outcome: 'error',
            error: sanitizeDispatchError(error),
          })
          postReply(hostParentPort, request.requestId, error)
          if (request.requestId === shutdownRequestId) shutdown()
        }),
      ),
      Effect.asVoid,
    )
  })

  hostParentPort.on('message', (messageEvent: { data: unknown }) => {
    const request = messageEvent.data
    if (!isNativeRuntimeRequest(request)) return
    Effect.runSync(dispatchRequestEffect(request))
  })
})

export function isAdvisoryNativeRuntimeEventCandidate(
  event: Record<string, unknown>,
) {
  return event.type === 'screenBackendRestart' ||
    event.type === 'stats' ||
    event.type === 'microphoneMetrics' ||
    event.type === 'activeSpeakers'
}

export function shouldLogNativeRuntimeEvent(
  event: Pick<NativeRuntimeEvent, 'type'>,
) {
  return event.type !== 'microphoneMetrics' &&
    event.type !== 'remoteVideoFrame' &&
    event.type !== 'localScreenPreviewFrame' &&
    event.type !== 'localCameraPreviewFrame'
}

function isFrameReleaseCommand(command: NativeRuntimeRequest['command']) {
  return command.type === 'releaseRemoteVideoFrame' ||
    command.type === 'releaseLocalScreenPreviewFrame' ||
    command.type === 'releaseLocalCameraPreviewFrame'
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
  environment: NodeJS.ProcessEnv,
): NativeDiagnosticLog | null {
  const runId = environment.SYRNIKE_NATIVE_DIAGNOSTIC_RUN_ID
  const filePath = environment.SYRNIKE_NATIVE_UTILITY_LOG_PATH
  if (runtime !== 'media' || !runId || !filePath) return null
  return createNativeDiagnosticLog({
    runtime,
    role: 'utility',
    runId,
    directory: path.dirname(filePath),
    filePath,
  })
}
