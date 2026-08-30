import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { Effect, Option, Schema } from 'effect'

import {
  MEDIA_LIFECYCLE_PROTOCOL_VERSION,
  MediaAddonHandshakeSchema,
  MediaAddonPingSchema,
  MediaAddonShutdownSchema,
  MediaLifecycleEventSchema,
  failureFromUnknown,
  isMediaLifecycleRequest,
  mediaLifecycleFailure,
  type MediaLifecycleEvent,
  type MediaLifecycleFailure,
  type MediaLifecycleReady,
  type MediaLifecycleReply,
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
  registerEventCallback(callback: (event: unknown) => void): unknown
  handshake(): unknown
  ping(): unknown
  shutdown(): unknown
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
    typeof Reflect.get(input, 'registerEventCallback') === 'function' &&
    typeof Reflect.get(input, 'handshake') === 'function' &&
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
    !/^[0-9a-f]{40}$/i.test(commitSha) ||
    protocolVersion !== MEDIA_LIFECYCLE_PROTOCOL_VERSION
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
  const emit = (rawEvent: unknown) => {
    const decoded = Schema.decodeUnknownOption(MediaLifecycleEventSchema)(rawEvent)
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
    hostPort.postMessage({ type: 'event', event: decoded.value })
  }

  const registered = yield* invokeAddon(
    () => addon.registerEventCallback(emit),
    'register_event_callback',
  ).pipe(
    Effect.catch((failure) => {
      failStartup(failure)
      return Effect.succeed(null)
    }),
  )
  if (registered === null) return

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
  const handshake = Schema.decodeUnknownOption(MediaAddonHandshakeSchema)(
    handshakeValue,
  )
  if (
    Option.isNone(handshake) ||
    handshake.value.protocolVersion !== MEDIA_LIFECYCLE_PROTOCOL_VERSION ||
    handshake.value.engineState !== 'running' ||
    handshake.value.build.commit !== manifest.commitSha ||
    Number(handshake.value.build.napi) !== manifest.napiVersion
  ) {
    failStartup(
      mediaLifecycleFailure(
        'media_handshake_incompatible',
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
    if (!isMediaLifecycleRequest(request)) return
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
    if (request.command.type === 'ping') {
      void Effect.runPromise(
        invokeAddon(() => addon.ping(), 'ping').pipe(
          Effect.flatMap((value) => {
            const decoded = Schema.decodeUnknownOption(MediaAddonPingSchema)(value)
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
    if (shuttingDown) return
    shuttingDown = true
    void Effect.runPromise(
      invokeAddon(() => addon.shutdown(), 'shutdown').pipe(
        Effect.flatMap((value) => {
          const decoded = Schema.decodeUnknownOption(MediaAddonShutdownSchema)(value)
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

function postSuccessReply(
  port: ParentPort,
  requestId: string,
  result: unknown,
) {
  port.postMessage({
    type: 'reply',
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
    requestId,
    ok: false,
    failure,
  } satisfies MediaLifecycleReply)
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

