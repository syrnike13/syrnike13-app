import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { Effect, Option, Schema } from 'effect'

import {
  MEDIA_LIFECYCLE_MAX_REQUEST_ID_LENGTH,
  MEDIA_LIFECYCLE_PROTOCOL_VERSION,
  MEDIA_UTILITY_BOOTSTRAP_MESSAGE,
  MediaAddonHandshakeSchema,
  MediaAddonPingSchema,
  MediaAddonSnapshotSchema,
  MediaAddonShutdownSchema,
  MediaCredentialLeaseInstalledSchema,
  MediaDesiredStateAcceptedSchema,
  MediaLifecycleDiagnosticEventSchema,
  MediaLifecycleEventSchema,
  failureFromUnknown,
  isMediaLifecycleRequest,
  mediaLifecycleFailure,
  redactMediaLifecycleText,
  type MediaLifecycleEvent,
  type MediaLifecycleFailure,
  type MediaLifecycleReady,
  type MediaLifecycleReply,
  type MediaLifecycleResult,
} from '../main/media-runtime/contract'
import {
  type MediaArtifactExpectations,
  type MediaArtifactManifest,
  verifyMediaArtifactDistribution,
} from '../main/media-runtime/media-artifacts'

type ParentPort = {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: unknown): void
}

type MediaLifecycleAddon = {
  registerPublicEventCallback(callback: (event: unknown) => void): unknown
  registerDiagnosticEventCallback(callback: (event: unknown) => void): unknown
  handshake(): unknown
  installCredentialLease(lease: unknown, deadlineMs?: number): unknown
  applyDesiredState(desiredState: unknown, deadlineMs?: number): unknown
  querySnapshot(deadlineMs?: number): unknown
  ping(deadlineMs?: number): unknown
  shutdown(deadlineMs?: number): unknown
}

type MediaHostDependencies = {
  parentPort?: ParentPort
  environment?: NodeJS.ProcessEnv
  nativeModuleExists?(modulePath: string): boolean
  verifyDistribution?(
    mediaRoot: string,
    expected: MediaArtifactExpectations,
  ): MediaArtifactManifest
  loadAddon?(modulePath: string): unknown
  registerShutdownSignals?(shutdown: () => void): void
  exit?(code: number): void
  scheduleExit?(exit: () => void): void
}

const ParentPortSchema = Schema.declare<ParentPort>(
  (input): input is ParentPort =>
    typeof input === 'object' &&
    input !== null &&
    typeof Reflect.get(input, 'on') === 'function' &&
    typeof Reflect.get(input, 'postMessage') === 'function',
)

const MediaLifecycleAddonSchema = Schema.declare<MediaLifecycleAddon>(
  (input): input is MediaLifecycleAddon =>
    typeof input === 'object' &&
    input !== null &&
    typeof Reflect.get(input, 'registerPublicEventCallback') === 'function' &&
    typeof Reflect.get(input, 'registerDiagnosticEventCallback') === 'function' &&
    typeof Reflect.get(input, 'handshake') === 'function' &&
    typeof Reflect.get(input, 'installCredentialLease') === 'function' &&
    typeof Reflect.get(input, 'applyDesiredState') === 'function' &&
    typeof Reflect.get(input, 'querySnapshot') === 'function' &&
    typeof Reflect.get(input, 'ping') === 'function' &&
    typeof Reflect.get(input, 'shutdown') === 'function',
)

const processParentPort: unknown = Reflect.get(process, 'parentPort')
const parentPort = Schema.is(ParentPortSchema)(processParentPort)
  ? processParentPort
  : undefined

export function runMediaUtilityHost(dependencies: MediaHostDependencies = {}) {
  return Effect.runPromise(runMediaUtilityHostEffect(dependencies))
}

export const runMediaUtilityHostEffect = Effect.fn(
  'desktop.runMediaUtilityHost',
)(function* (dependencies: MediaHostDependencies = {}) {
  const hostPort = dependencies.parentPort ?? parentPort
  if (!hostPort) {
    return yield* Effect.fail(
      new Error('Media utility host has no Electron parent port'),
    )
  }
  if (dependencies.parentPort === undefined) {
    yield* Effect.promise(() => waitForMediaUtilityBootstrap(hostPort))
  }
  const environment = dependencies.environment ?? process.env
  const moduleExists = dependencies.nativeModuleExists ?? existsSync
  const verifyDistribution =
    dependencies.verifyDistribution ?? verifyMediaArtifactDistribution
  const exit = dependencies.exit ?? ((code: number) => process.exit(code))
  const scheduleExit =
    dependencies.scheduleExit ?? ((operation: () => void) => setImmediate(operation))
  const failStartup = (failure: MediaLifecycleFailure) => {
    postIncompatibleReady(hostPort, failure)
    scheduleExit(() => exit(1))
  }

  const modulePath = environment.SYRNIKE_MEDIA_MODULE_PATH
  const mediaRoot = environment.SYRNIKE_MEDIA_ROOT
  const appVersion = environment.SYRNIKE_MEDIA_APP_VERSION
  const releaseChannel = environment.SYRNIKE_MEDIA_RELEASE_CHANNEL
  const commitSha = environment.SYRNIKE_MEDIA_COMMIT_SHA
  const protocolVersion = Number(environment.SYRNIKE_MEDIA_PROTOCOL_VERSION)
  if (protocolVersion !== MEDIA_LIFECYCLE_PROTOCOL_VERSION) {
    failStartup(
      mediaLifecycleFailure(
        'protocol_incompatible',
        'Media utility host requires the exact media lifecycle protocol version',
        'environment',
      ),
    )
    return
  }
  if (
    !modulePath ||
    !mediaRoot ||
    !appVersion ||
    !path.isAbsolute(modulePath) ||
    !path.isAbsolute(mediaRoot) ||
    path.dirname(modulePath) !== mediaRoot ||
    path.basename(modulePath) !== 'windows_media.node' ||
    !moduleExists(modulePath) ||
    (releaseChannel !== 'stable' && releaseChannel !== 'nightly') ||
    !commitSha ||
    !/^[0-9a-f]{40}$/i.test(commitSha)
  ) {
    failStartup(
      mediaLifecycleFailure(
        'media_host_environment_invalid',
        'Media utility host environment is invalid or incompatible',
        'environment',
      ),
    )
    return
  }

  const manifest = yield* Effect.try({
    try: () =>
      verifyDistribution(mediaRoot, {
        appVersion,
        commitSha,
        electronVersion: process.versions.electron,
        releaseChannel,
      }),
    catch: (cause) => failureFromUnknown(cause, 'artifact_verification'),
  }).pipe(
    Effect.catch((failure) => {
      failStartup(failure)
      return Effect.succeed(null)
    }),
  )
  if (!manifest) return

  const require = createRequire(path.resolve(process.cwd(), 'windows-media-host.cjs'))
  const addon = yield* Effect.try({
    try: () => {
      const loaded: unknown = dependencies.loadAddon
        ? dependencies.loadAddon(modulePath)
        : require(modulePath)
      if (!Schema.is(MediaLifecycleAddonSchema)(loaded)) {
        throw new TypeError('windows_media.node has an invalid lifecycle contract')
      }
      return loaded
    },
    catch: (cause) => failureFromUnknown(cause, 'addon_load'),
  }).pipe(
    Effect.catch((failure) => {
      failStartup(failure)
      return Effect.succeed(null)
    }),
  )
  if (!addon) return

  let shuttingDown = false
  let boundHostEpoch: number | undefined
  const emitPublic = (rawEvent: unknown) => {
    const decoded = Schema.decodeUnknownOption(MediaLifecycleEventSchema, {
      onExcessProperty: 'error',
    })(rawEvent)
    if (Option.isNone(decoded)) {
      failStartup(
        mediaLifecycleFailure(
          'media_event_invalid',
          'Native media lifecycle callback emitted an invalid event',
          'event_callback',
        ),
      )
      return
    }
    hostPort.postMessage({
      type: 'event',
      protocolVersion: MEDIA_LIFECYCLE_PROTOCOL_VERSION,
      event: sanitizePublicEvent(decoded.value),
    })
  }

  const emitDiagnostic = (rawEvent: unknown) => {
    const decoded = Schema.decodeUnknownOption(
      MediaLifecycleDiagnosticEventSchema,
      { onExcessProperty: 'error' },
    )(rawEvent)
    if (Option.isNone(decoded)) return
    const event = decoded.value.implementation
      ? {
          ...decoded.value,
          implementation: decoded.value.implementation.map((field) => ({
            ...field,
            value: redactMediaLifecycleText(field.value),
          })),
        }
      : decoded.value
    hostPort.postMessage({
      type: 'diagnostic',
      protocolVersion: MEDIA_LIFECYCLE_PROTOCOL_VERSION,
      event,
    })
  }

  const publicRegistered = yield* invokeAddon(
    () => addon.registerPublicEventCallback(emitPublic),
    'register_public_event_callback',
  ).pipe(
    Effect.catch((failure) => {
      failStartup(failure)
      return Effect.succeed(null)
    }),
  )
  if (publicRegistered === null) return
  const diagnosticRegistered = yield* invokeAddon(
    () => addon.registerDiagnosticEventCallback(emitDiagnostic),
    'register_diagnostic_event_callback',
  ).pipe(
    Effect.catch((failure) => {
      failStartup(failure)
      return Effect.succeed(null)
    }),
  )
  if (diagnosticRegistered === null) return

  const handshakeValue = yield* invokeAddon(
    () => addon.handshake(),
    'handshake',
  ).pipe(
    Effect.catch((failure) => {
      failStartup(failure)
      return Effect.succeed(null)
    }),
  )
  if (handshakeValue === null) return
  const handshake = Schema.decodeUnknownOption(MediaAddonHandshakeSchema, {
    onExcessProperty: 'error',
  })(handshakeValue)
  if (
    Option.isNone(handshake) ||
    handshake.value.protocolVersion !== MEDIA_LIFECYCLE_PROTOCOL_VERSION ||
    handshake.value.engineState !== 'running' ||
    handshake.value.build.commit !== manifest.commitSha ||
    handshake.value.build.protocolSchemaSha256 !== manifest.protocolSchemaSha256 ||
    Number(handshake.value.build.napi) !== manifest.napiVersion
  ) {
    failStartup(
      mediaLifecycleFailure(
        'protocol_incompatible',
        'Native media lifecycle handshake is incompatible with its manifest',
        'handshake',
      ),
    )
    return
  }

  const ready: MediaLifecycleReady = {
    type: 'ready',
    protocolVersion: MEDIA_LIFECYCLE_PROTOCOL_VERSION,
    engineState: 'running',
    build: handshake.value.build,
  }
  hostPort.postMessage(ready)

  const stop = () => {
    if (shuttingDown) return
    shuttingDown = true
    void Effect.runPromise(
      invokeAddon(() => addon.shutdown(), 'shutdown').pipe(
        Effect.ignore,
        Effect.ensuring(Effect.sync(() => exit(0))),
      ),
    )
  }
  if (dependencies.registerShutdownSignals) {
    dependencies.registerShutdownSignals(stop)
  } else {
    process.once('disconnect', stop)
    process.once('SIGTERM', stop)
  }

  hostPort.on('message', (messageEvent) => {
    const request = messageEvent.data
    if (!isMediaLifecycleRequest(request)) {
      const requestId = malformedRequestId(request)
      if (requestId) {
        postFailureReply(
          hostPort,
          requestId,
          mediaLifecycleFailure(
            malformedProtocolVersion(request) ? 'protocol_incompatible' : 'protocol_invalid',
            'Media request does not match the exact media lifecycle protocol contract',
            'protocol',
          ),
        )
      }
      return
    }
    if (boundHostEpoch === undefined) boundHostEpoch = request.hostEpoch
    if (request.hostEpoch !== boundHostEpoch) {
      postFailureReply(
        hostPort,
        request.requestId,
        mediaLifecycleFailure(
          'stale_media_host_epoch',
          'Media request belongs to a retired utility host epoch',
          request.command.type,
        ),
      )
      return
    }
    if (request.command.type === 'handshake') {
      postSuccessReply(hostPort, request.requestId, {
        type: 'handshake',
        protocolVersion: MEDIA_LIFECYCLE_PROTOCOL_VERSION,
        engineState: 'running',
        build: handshake.value.build,
      })
      return
    }
    if (request.command.type === 'installCredentialLease') {
      const lease = request.command.lease
      void Effect.runPromise(
        invokeAddon(
          () => addon.installCredentialLease(lease, request.deadlineMs),
          'install_credential_lease',
        ).pipe(
          Effect.flatMap((value) => {
            const decoded = Schema.decodeUnknownOption(
              MediaCredentialLeaseInstalledSchema,
              { onExcessProperty: 'error' },
            )(value)
            return Option.isSome(decoded)
              ? Effect.sync(() =>
                  postSuccessReply(hostPort, request.requestId, decoded.value),
                )
              : Effect.fail(
                  mediaLifecycleFailure(
                    'media_credential_lease_invalid',
                    'Native media credential lease returned an invalid result',
                    'install_credential_lease',
                  ),
                )
          }),
          Effect.catch((failure) =>
            Effect.sync(() => postFailureReply(hostPort, request.requestId, failure)),
          ),
        ),
      )
      return
    }
    if (request.command.type === 'applyDesiredState') {
      const desiredState = request.command.desiredState
      void Effect.runPromise(
        invokeAddon(
          () => addon.applyDesiredState(desiredState, request.deadlineMs),
          'apply_desired_state',
        ).pipe(
          Effect.flatMap((value) => {
            const decoded = Schema.decodeUnknownOption(
              MediaDesiredStateAcceptedSchema,
              { onExcessProperty: 'error' },
            )(value)
            return Option.isSome(decoded)
              ? Effect.sync(() =>
                  postSuccessReply(hostPort, request.requestId, decoded.value),
                )
              : Effect.fail(
                  mediaLifecycleFailure(
                    'media_apply_invalid',
                    'Native media apply returned an invalid result',
                    'apply_desired_state',
                  ),
                )
          }),
          Effect.catch((failure) =>
            Effect.sync(() => postFailureReply(hostPort, request.requestId, failure)),
          ),
        ),
      )
      return
    }
    if (request.command.type === 'querySnapshot') {
      void Effect.runPromise(
        invokeAddon(
          () => addon.querySnapshot(request.deadlineMs),
          'query_snapshot',
        ).pipe(
          Effect.flatMap((value) => {
            const decoded = Schema.decodeUnknownOption(MediaAddonSnapshotSchema, {
              onExcessProperty: 'error',
            })(value)
            return Option.isSome(decoded)
              ? Effect.sync(() =>
                  postSuccessReply(hostPort, request.requestId, decoded.value),
                )
              : Effect.fail(
                  mediaLifecycleFailure(
                    'media_snapshot_invalid',
                    'Native media query returned an invalid snapshot',
                    'query_snapshot',
                  ),
                )
          }),
          Effect.catch((failure) =>
            Effect.sync(() => postFailureReply(hostPort, request.requestId, failure)),
          ),
        ),
      )
      return
    }
    if (request.command.type === 'ping') {
      void Effect.runPromise(
        invokeAddon(() => addon.ping(request.deadlineMs), 'ping').pipe(
          Effect.flatMap((value) => {
            const decoded = Schema.decodeUnknownOption(MediaAddonPingSchema, {
              onExcessProperty: 'error',
            })(value)
            if (Option.isNone(decoded)) {
              return Effect.fail(
                mediaLifecycleFailure(
                  'media_ping_invalid',
                  'Native media ping returned an invalid result',
                  'ping',
                ),
              )
            }
            return Effect.sync(() =>
              postSuccessReply(hostPort, request.requestId, decoded.value),
            )
          }),
          Effect.catch((failure) =>
            Effect.sync(() =>
              postFailureReply(hostPort, request.requestId, failure),
            ),
          ),
        ),
      )
      return
    }
    if (shuttingDown) {
      postFailureReply(
        hostPort,
        request.requestId,
        mediaLifecycleFailure(
          'engine_stopping',
          'Media engine shutdown has already started',
          'shutdown',
        ),
      )
      return
    }
    shuttingDown = true
    void Effect.runPromise(
      invokeAddon(
        () => addon.shutdown(request.deadlineMs),
        'shutdown',
      ).pipe(
        Effect.flatMap((value) => {
          const decoded = Schema.decodeUnknownOption(MediaAddonShutdownSchema, {
            onExcessProperty: 'error',
          })(value)
          if (Option.isNone(decoded)) {
            return Effect.fail(
              mediaLifecycleFailure(
                'media_shutdown_invalid',
                'Native media shutdown returned an invalid result',
                'shutdown',
              ),
            )
          }
          return Effect.sync(() =>
            postSuccessReply(hostPort, request.requestId, decoded.value),
          )
        }),
        Effect.catch((failure) =>
          Effect.sync(() =>
            postFailureReply(hostPort, request.requestId, failure),
          ),
        ),
        Effect.ensuring(
          Effect.sync(() => scheduleExit(() => exit(0))),
        ),
      ),
    )
  })
})

function invokeAddon(operation: () => unknown, stage: string) {
  return Effect.try({
    try: operation,
    catch: (cause) => failureFromUnknown(cause, stage),
  })
}

function sanitizePublicEvent(event: MediaLifecycleEvent): MediaLifecycleEvent {
  if (event.type === 'fatalEngineFailure') {
    return {
      ...event,
      failure: mediaLifecycleFailure(
        event.failure.code,
        event.failure.message,
        event.failure.stage,
        event.failure.retryable,
      ),
    }
  }
  if (
    (event.type === 'engineStateChanged' || event.type === 'roomStateChanged') &&
    event.failure
  ) {
    return {
      ...event,
      failure: mediaLifecycleFailure(
        event.failure.code,
        event.failure.message,
        event.failure.stage,
        event.failure.retryable,
      ),
    }
  }
  return event
}

function postSuccessReply(
  port: ParentPort,
  requestId: string,
  result: MediaLifecycleResult,
) {
  port.postMessage({
    type: 'reply',
    protocolVersion: MEDIA_LIFECYCLE_PROTOCOL_VERSION,
    requestId,
    ok: true,
    result,
  } satisfies MediaLifecycleReply)
}

function postFailureReply(
  port: ParentPort,
  requestId: string,
  failure: MediaLifecycleFailure,
) {
  port.postMessage({
    type: 'reply',
    protocolVersion: MEDIA_LIFECYCLE_PROTOCOL_VERSION,
    requestId,
    ok: false,
    failure,
  } satisfies MediaLifecycleReply)
}

function malformedRequestId(value: unknown) {
  if (typeof value !== 'object' || value === null || Reflect.get(value, 'type') !== 'request') {
    return undefined
  }
  const requestId = Reflect.get(value, 'requestId')
  return typeof requestId === 'string' && requestId.length > 0 &&
    requestId.length <= MEDIA_LIFECYCLE_MAX_REQUEST_ID_LENGTH
    ? requestId
    : undefined
}

function malformedProtocolVersion(value: unknown) {
  return typeof value === 'object' && value !== null &&
    Reflect.get(value, 'protocolVersion') !== MEDIA_LIFECYCLE_PROTOCOL_VERSION
}

function postIncompatibleReady(
  port: ParentPort,
  failure: MediaLifecycleFailure,
) {
  port.postMessage({
    type: 'ready',
    protocolVersion: 0,
    engineState: 'failed',
    failure,
  } satisfies MediaLifecycleReady)
}

function waitForMediaUtilityBootstrap(port: ParentPort) {
  return new Promise<void>((resolve) => {
    let started = false
    port.on('message', (event) => {
      if (started || event.data !== MEDIA_UTILITY_BOOTSTRAP_MESSAGE) return
      started = true
      resolve()
    })
  })
}
