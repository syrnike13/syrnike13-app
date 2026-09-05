import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { Effect, Schema } from 'effect'

import {
  NATIVE_RUNTIME_CONTRACT_VERSION,
  isNativeRuntimeEvent,
  isNativeRuntimeReply,
  isNativeRuntimeRequest,
  isUncorrelatedNativeRuntimeReply,
  nativeRuntimeError,
  sanitizeRuntimeError,
  type NativeRuntimeEvent,
  type NativeRuntimeKind,
  type NativeRuntimeReady,
  type NativeRuntimeReply,
} from '../main/native-runtime/contract'
import {
  type NativeArtifactExpectations,
  type NativeArtifactManifest,
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
  createHotkeyRuntime?: NativeRuntimeFactory
  createOverlayRuntime?: NativeRuntimeFactory
  getRuntimeInfo(): unknown
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
  createHotkeyRuntime: Schema.optionalKey(NativeRuntimeFactorySchema),
  createOverlayRuntime: Schema.optionalKey(NativeRuntimeFactorySchema),
  getRuntimeInfo: RuntimeInfoFactorySchema,
})

const NativeRuntimeInfoSchema = Schema.Struct({
  runtime: Schema.String,
  contractVersion: Schema.Number,
  capabilities: Schema.Array(Schema.String),
  commit: Schema.String,
  napi: Schema.String,
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
  hotkey: ['hotkeys'],
  overlay: ['overlay'],
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
)(function* (
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
  const processCrashReporter: unknown = Reflect.get(process, 'crashReporter')
  const crashReporter =
    dependencies.crashReporter ??
    (Schema.is(UtilityCrashReporterSchema)(processCrashReporter)
      ? processCrashReporter
      : undefined)
  const annotateCrash = (key: string, value: string | undefined) => {
    if (!crashReporter || !value) return
    try {
      crashReporter.addExtraParameter(key, value.slice(0, 127))
    } catch {
      // Crash reporting is optional and must not affect the hooks host.
    }
  }

  annotateCrash('native_runtime_kind', runtimeKind)
  annotateCrash('native_runtime_commit', environment.SYRNIKE_NATIVE_COMMIT_SHA)
  annotateCrash('native_host_stage', 'utility_startup')

  const nativeModulePath = environment.SYRNIKE_NATIVE_MODULE_PATH
  const nativeRoot = environment.SYRNIKE_NATIVE_ROOT
  if (
    !nativeModulePath ||
    !nativeRoot ||
    !path.isAbsolute(nativeModulePath) ||
    !path.isAbsolute(nativeRoot) ||
    path.dirname(nativeModulePath) !== nativeRoot ||
    path.basename(nativeModulePath) !== `syrnike_${runtimeKind}.node` ||
    !nativeModuleExists(nativeModulePath)
  ) {
    postIncompatibleReady(hostParentPort, runtimeKind)
    return
  }

  const releaseChannel = environment.SYRNIKE_NATIVE_RELEASE_CHANNEL
  const appVersion = environment.SYRNIKE_NATIVE_APP_VERSION
  const expectedContractVersion = Number(
    environment.SYRNIKE_NATIVE_CONTRACT_VERSION,
  )
  const expectedCommitSha = environment.SYRNIKE_NATIVE_COMMIT_SHA
  if (
    !appVersion ||
    (releaseChannel !== 'stable' && releaseChannel !== 'nightly') ||
    expectedContractVersion !== NATIVE_RUNTIME_CONTRACT_VERSION ||
    !expectedCommitSha ||
    !/^[0-9a-f]{40}$/i.test(expectedCommitSha)
  ) {
    postIncompatibleReady(hostParentPort, runtimeKind)
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
        releaseChannel,
      }),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch(() => {
      postIncompatibleReady(hostParentPort, runtimeKind)
      return Effect.succeed(null)
    }),
  )
  if (!manifest) return

  const require = createRequire(path.resolve(process.cwd(), 'syrnike-hooks-host.cjs'))
  const addon = yield* Effect.try({
    try: () => {
      annotateCrash('native_host_stage', 'addon_load')
      const loaded: unknown = dependencies.loadAddon
        ? dependencies.loadAddon(nativeModulePath)
        : require(nativeModulePath)
      if (!Schema.is(NativeRuntimeAddonSchema)(loaded)) {
        throw new TypeError('Native hooks addon has an invalid contract')
      }
      return loaded
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catch(() => {
      postIncompatibleReady(hostParentPort, runtimeKind)
      return Effect.succeed(null)
    }),
  )
  if (!addon) return

  const info = yield* Effect.try({
    try: () => {
      const value: unknown = addon.getRuntimeInfo()
      if (!Schema.is(NativeRuntimeInfoSchema)(value)) {
        throw new TypeError('Native hooks runtime info has an invalid contract')
      }
      return value
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catch(() => {
      postIncompatibleReady(hostParentPort, runtimeKind)
      return Effect.succeed(null)
    }),
  )
  if (!info) return

  const actualRuntime =
    info.runtime === 'hotkey' || info.runtime === 'overlay'
      ? info.runtime
      : 'invalid'
  const capabilitiesMatch =
    info.capabilities.length <= 32 &&
    REQUIRED_CAPABILITIES[runtimeKind].every((capability) =>
      info.capabilities.includes(capability),
    )
  const buildMatches =
    info.commit === manifest.commitSha &&
    Number(info.napi) === manifest.napiVersion
  const ready: NativeRuntimeReady = {
    type: 'ready',
    contractVersion:
      actualRuntime === runtimeKind &&
      capabilitiesMatch &&
      buildMatches &&
      info.contractVersion === NATIVE_RUNTIME_CONTRACT_VERSION
        ? NATIVE_RUNTIME_CONTRACT_VERSION
        : 0,
    runtime: actualRuntime,
    capabilities: info.capabilities,
    build: {
      ...(process.versions.electron
        ? { electron: process.versions.electron }
        : {}),
      commit: info.commit,
      napi: info.napi,
    },
  }
  if (ready.contractVersion !== NATIVE_RUNTIME_CONTRACT_VERSION) {
    hostParentPort.postMessage(ready)
    return
  }

  const factory =
    runtimeKind === 'hotkey'
      ? addon.createHotkeyRuntime
      : addon.createOverlayRuntime
  if (!factory) {
    postIncompatibleReady(hostParentPort, runtimeKind)
    return
  }

  let runtime: NativeRuntimeInstance | null = null
  let shuttingDown = false
  let shutdownRequestId: string | null = null
  let boundHostEpoch: number | undefined
  const shutdown = (exitCode = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    const current = runtime
    runtime = null
    Effect.runFork(
      Effect.tryPromise({
        try: () => Promise.resolve(current?.shutdown()),
        catch: (cause) => cause,
      }).pipe(
        Effect.match({
          onFailure: () => exit(1),
          onSuccess: () => exit(exitCode),
        }),
      ),
    )
  }

  const failContractCorruption = () => {
    hostParentPort.postMessage({
      type: 'event',
      event: {
        type: 'runtimeError',
        sequence: 0,
        error: nativeRuntimeError(
          'invalid_native_event',
          'Native hooks runtime emitted an invalid event',
        ),
      } satisfies NativeRuntimeEvent,
    })
    shutdown(1)
  }

  const emit = (rawEvent: Record<string, unknown>) => {
    if (isUncorrelatedNativeRuntimeReply(rawEvent)) return
    if (rawEvent.type === 'reply') {
      if (!isNativeRuntimeReply(rawEvent)) {
        failContractCorruption()
        return
      }
      const reply: NativeRuntimeReply = rawEvent.ok
        ? rawEvent
        : { ...rawEvent, error: sanitizeRuntimeError(rawEvent.error) }
      hostParentPort.postMessage(reply)
      if (rawEvent.requestId === shutdownRequestId) shutdown()
      return
    }
    if (!isNativeRuntimeEvent(rawEvent)) {
      failContractCorruption()
      return
    }
    hostParentPort.postMessage({ type: 'event', event: rawEvent })
  }

  const createdRuntime: unknown = yield* Effect.try({
    try: () => factory(emit),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch(() => {
      postIncompatibleReady(hostParentPort, runtimeKind)
      return Effect.succeed(null)
    }),
  )
  if (!createdRuntime || !Schema.is(NativeRuntimeInstanceSchema)(createdRuntime)) {
    postIncompatibleReady(hostParentPort, runtimeKind)
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
    shutdown(1)
    return
  }

  annotateCrash('native_host_stage', 'ready')
  hostParentPort.postMessage(ready)
  hostParentPort.on('message', (messageEvent) => {
    const request = messageEvent.data
    if (!isNativeRuntimeRequest(request)) return
    if (boundHostEpoch === undefined) boundHostEpoch = request.hostEpoch
    if (request.hostEpoch !== boundHostEpoch) {
      hostParentPort.postMessage({
        type: 'reply',
        requestId: request.requestId,
        ok: false,
        error: nativeRuntimeError(
          'stale_host_epoch',
          'Native request belongs to a retired utility host epoch',
        ),
      } satisfies NativeRuntimeReply)
      return
    }
    annotateCrash('native_last_command', request.command.type)
    annotateCrash('native_last_lane', request.lane)
    if (request.command.type === 'shutdown') shutdownRequestId = request.requestId
    try {
      runtime?.dispatch({
        ...request.command,
        requestId: request.requestId,
        lane: request.lane,
        hostEpoch: request.hostEpoch,
        diagnostic: request.diagnostic,
      })
    } catch (error) {
      postReply(hostParentPort, request.requestId, error)
      if (request.requestId === shutdownRequestId) shutdown()
    }
  })
})

function postReply(port: ParentPort, requestId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const detail = /\bqueue[_ -]?full\b/i.test(message)
    ? nativeRuntimeError(
        'queue_full',
        'Native runtime command queue is full',
        { retryable: true },
      )
    : sanitizeRuntimeError(error)
  port.postMessage({
    type: 'reply',
    requestId,
    ok: false,
    error: detail,
  } satisfies NativeRuntimeReply)
}

function postIncompatibleReady(port: ParentPort, runtime: NativeRuntimeKind) {
  port.postMessage({
    type: 'ready',
    contractVersion: 0,
    runtime,
    capabilities: [],
    build: {
      ...(process.versions.electron
        ? { electron: process.versions.electron }
        : {}),
      ...(process.versions.napi ? { napi: process.versions.napi } : {}),
    },
  } satisfies NativeRuntimeReady)
}
