import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

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
  createHooksRuntime?: (
    emit: (event: Record<string, unknown>) => void,
  ) => NativeRuntimeInstance
  getRuntimeInfo?: () => {
    runtime?: string
    contractVersion?: number
    capabilities?: string[]
    commit?: string
    napi?: string
    livekit?: string
  }
}

const REQUIRED_CAPABILITIES: Record<NativeRuntimeKind, readonly string[]> = {
  media: ['microphone', 'screen', 'screenAudio', 'preview', 'queries'],
  hooks: ['hotkeys', 'overlay'],
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

  const nativeModulePath = process.env.SYRNIKE_NATIVE_MODULE_PATH
  const nativeRoot = process.env.SYRNIKE_NATIVE_ROOT
  const expectedModuleName =
    runtimeKind === 'media' ? 'syrnike_media.node' : 'syrnike_hooks.node'
  if (
    !nativeModulePath ||
    !nativeRoot ||
    !path.isAbsolute(nativeModulePath) ||
    !path.isAbsolute(nativeRoot) ||
    path.dirname(nativeModulePath) !== nativeRoot ||
    path.basename(nativeModulePath) !== expectedModuleName ||
    !existsSync(nativeModulePath)
  ) {
    postIncompatibleReady(parentPort, runtimeKind)
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
    postIncompatibleReady(parentPort, runtimeKind)
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
  } catch {
    postIncompatibleReady(parentPort, runtimeKind)
    return
  }

  const require = createRequire(path.resolve(process.cwd(), 'syrnike-utility-host.cjs'))
  let addon: NativeRuntimeAddon
  try {
    addon = require(nativeModulePath) as NativeRuntimeAddon
  } catch {
    postIncompatibleReady(parentPort, runtimeKind)
    return
  }
  let info: ReturnType<NonNullable<NativeRuntimeAddon['getRuntimeInfo']>> = {}
  try {
    info = addon.getRuntimeInfo?.() ?? {}
  } catch {
    postIncompatibleReady(parentPort, runtimeKind)
    return
  }
  const factory =
    runtimeKind === 'media'
      ? addon.createMediaRuntime
      : addon.createHooksRuntime

  let runtime: NativeRuntimeInstance | null = null
  let shutdownRequestId: string | null = null
  let shuttingDown = false
  let contractCorrupted = false
  const shutdown = (exitCode = 0) => {
    if (shuttingDown) return
    shuttingDown = true
    const current = runtime
    runtime = null
    void Promise.resolve()
      .then(() => current?.shutdown())
      .then(
        () => process.exit(exitCode),
        () => process.exit(1),
      )
  }
  const failContractCorruption = () => {
    if (contractCorrupted) return
    contractCorrupted = true
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
    setImmediate(() => process.exit(1))
  }
  const emit = (rawEvent: Record<string, unknown>) => {
    if (isNativeReplyEvent(rawEvent)) {
      if (!isNativeRuntimeReply(rawEvent)) {
        failContractCorruption()
        return
      }
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
    parentPort.postMessage({ type: 'event', event: rawEvent })
  }

  const actualRuntime =
    info.runtime === 'media' || info.runtime === 'hooks'
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
    parentPort.postMessage(ready)
    return
  }

  if (!factory) {
    postIncompatibleReady(parentPort, runtimeKind)
    return
  }
  runtime = factory(emit)
  process.once('disconnect', shutdown)
  process.once('SIGTERM', shutdown)
  try {
    await runtime.ready?.()
  } catch {
    shutdown(1)
    return
  }
  if (shuttingDown) return
  parentPort.postMessage({
    ...ready,
  })

  parentPort.on('message', (messageEvent: { data: unknown }) => {
    const request = messageEvent.data
    if (!isNativeRuntimeRequest(request)) return
    try {
      if (request.command.type === 'shutdown') {
        shutdownRequestId = request.requestId
      }
      runtime?.dispatch({
        ...request.command,
        requestId: request.requestId,
      })
    } catch (error) {
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
