import { Option, Schema } from 'effect'

export const MEDIA_LIFECYCLE_PROTOCOL_VERSION = 2
export const MEDIA_LIFECYCLE_MAX_PENDING_REQUESTS = 16
export const MEDIA_LIFECYCLE_CONTROL_QUEUE_CAPACITY = 16
export const MEDIA_LIFECYCLE_EVENT_QUEUE_CAPACITY = 64
export const MEDIA_LIFECYCLE_MAX_REQUEST_ID_LENGTH = 256
export const MEDIA_LIFECYCLE_MAX_IDENTIFIER_LENGTH = 256
export const MEDIA_LIFECYCLE_MAX_REMOTE_VIDEO_DEMANDS = 64
export const MEDIA_LIFECYCLE_MAX_DIAGNOSTIC_METRICS = 16
export const MEDIA_LIFECYCLE_MAX_DIAGNOSTIC_FIELDS = 16
export const MEDIA_LIFECYCLE_MAX_DEADLINE_MS = 5_000
export const MEDIA_LIFECYCLE_START_TIMEOUT_MS = 2_000
export const MEDIA_LIFECYCLE_HANDSHAKE_TIMEOUT_MS = 5_000
export const MEDIA_LIFECYCLE_PING_TIMEOUT_MS = 1_000
export const MEDIA_LIFECYCLE_SHUTDOWN_TIMEOUT_MS = 1_000
export const MEDIA_LIFECYCLE_OUTER_SHUTDOWN_MS = 1_500

const boundedString = (maximumLength: number, minimumLength = 1) =>
  Schema.String.check(
    Schema.isMinLength(minimumLength),
    Schema.isMaxLength(maximumLength),
  )

const protocolInteger = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
const positiveProtocolInteger = protocolInteger.check(Schema.isGreaterThan(0))
const requestIdSchema = boundedString(MEDIA_LIFECYCLE_MAX_REQUEST_ID_LENGTH)
const identifierSchema = boundedString(MEDIA_LIFECYCLE_MAX_IDENTIFIER_LENGTH).check(
  Schema.isPattern(/^[\x21-\x7e]+$/),
)
const offIntentSchema = Schema.Struct({ state: Schema.Literal('off') })

export const MediaLifecycleFailureSchema = Schema.Struct({
  code: boundedString(128),
  message: boundedString(4_096),
  stage: boundedString(128),
  retryable: Schema.Boolean,
})

export class MediaLifecycleError extends Schema.TaggedErrorClass<
  MediaLifecycleError
>()('MediaLifecycleError', {
  failure: MediaLifecycleFailureSchema,
}) {}

export const MediaEngineStateSchema = Schema.Literals([
  'stopped', 'starting', 'running', 'stopping', 'failed',
])

const MediaBuildIdentitySchema = Schema.Struct({
  commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/i)),
  napi: Schema.String.check(Schema.isPattern(/^\d+$/)),
})

export const RoomIntentSchema = Schema.Struct({
  roomId: identifierSchema,
  participantIdentity: identifierSchema,
})

export const RemoteVideoDemandSchema = Schema.Struct({
  participantIdentity: identifierSchema,
  publicationId: identifierSchema,
  quality: Schema.Literal('off'),
})

export const EngineDesiredStateSchema = Schema.Struct({
  revision: positiveProtocolInteger,
  room: Schema.Union([RoomIntentSchema, Schema.Null]),
  microphone: offIntentSchema,
  camera: offIntentSchema,
  screen: offIntentSchema,
  output: offIntentSchema,
  remoteVideoDemand: Schema.Array(RemoteVideoDemandSchema).check(
    Schema.isMaxLength(MEDIA_LIFECYCLE_MAX_REMOTE_VIDEO_DEMANDS),
  ),
})

const TrackPublicStateSchema = Schema.Struct({
  microphone: Schema.Literal('off'),
  camera: Schema.Literal('off'),
  screen: Schema.Literal('off'),
  output: Schema.Literal('off'),
})

export const MediaEngineSnapshotSchema = Schema.Struct({
  engineState: MediaEngineStateSchema,
  acceptedRevision: Schema.Union([protocolInteger, Schema.Null]),
  desiredState: Schema.Union([EngineDesiredStateSchema, Schema.Null]),
  roomState: Schema.Literals(['off', 'desired']),
  tracks: TrackPublicStateSchema,
})

export const MediaDesiredStateAcceptedSchema = Schema.Struct({
  type: Schema.Literal('desiredStateAccepted'),
  acceptedRevision: positiveProtocolInteger,
  disposition: Schema.Literals(['accepted', 'duplicate']),
})

export const MediaAddonHandshakeSchema = Schema.Struct({
  protocolVersion: Schema.Int,
  engineState: MediaEngineStateSchema,
  build: MediaBuildIdentitySchema,
})

export const MediaAddonPingSchema = Schema.Struct({
  type: Schema.Literal('pong'),
  engineState: Schema.Literal('running'),
})

export const MediaAddonShutdownSchema = Schema.Struct({
  type: Schema.Literal('shutdownComplete'),
  engineState: Schema.Literal('stopped'),
})

export const MediaAddonSnapshotSchema = Schema.Struct({
  type: Schema.Literal('snapshot'),
  snapshot: MediaEngineSnapshotSchema,
})

export const MediaLifecycleHandshakeResultSchema = Schema.Struct({
  type: Schema.Literal('handshake'),
  protocolVersion: Schema.Literal(MEDIA_LIFECYCLE_PROTOCOL_VERSION),
  engineState: Schema.Literal('running'),
  build: MediaBuildIdentitySchema,
})

export const MediaLifecycleReadySchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('ready'),
    protocolVersion: Schema.Literal(MEDIA_LIFECYCLE_PROTOCOL_VERSION),
    engineState: Schema.Literal('running'),
    build: MediaBuildIdentitySchema,
  }),
  Schema.Struct({
    type: Schema.Literal('ready'),
    protocolVersion: Schema.Literal(0),
    engineState: Schema.Literal('failed'),
    build: Schema.optional(MediaBuildIdentitySchema),
    failure: MediaLifecycleFailureSchema,
  }),
])

export const MediaLifecycleCommandSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('handshake') }),
  Schema.Struct({
    type: Schema.Literal('applyDesiredState'),
    desiredState: EngineDesiredStateSchema,
  }),
  Schema.Struct({ type: Schema.Literal('querySnapshot') }),
  Schema.Struct({ type: Schema.Literal('ping') }),
  Schema.Struct({ type: Schema.Literal('shutdown') }),
])

export const MediaLifecycleRequestSchema = Schema.Struct({
  type: Schema.Literal('request'),
  protocolVersion: Schema.Literal(MEDIA_LIFECYCLE_PROTOCOL_VERSION),
  requestId: requestIdSchema,
  hostEpoch: positiveProtocolInteger,
  deadlineMs: positiveProtocolInteger.check(
    Schema.isLessThanOrEqualTo(MEDIA_LIFECYCLE_MAX_DEADLINE_MS),
  ),
  command: MediaLifecycleCommandSchema,
})

export const MediaLifecycleResultSchema = Schema.Union([
  MediaLifecycleHandshakeResultSchema,
  MediaDesiredStateAcceptedSchema,
  MediaAddonSnapshotSchema,
  MediaAddonPingSchema,
  MediaAddonShutdownSchema,
])

export const MediaLifecycleReplySchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('reply'),
    protocolVersion: Schema.Literal(MEDIA_LIFECYCLE_PROTOCOL_VERSION),
    requestId: requestIdSchema,
    ok: Schema.Literal(true),
    result: MediaLifecycleResultSchema,
  }),
  Schema.Struct({
    type: Schema.Literal('reply'),
    protocolVersion: Schema.Literal(MEDIA_LIFECYCLE_PROTOCOL_VERSION),
    requestId: requestIdSchema,
    ok: Schema.Literal(false),
    failure: MediaLifecycleFailureSchema,
  }),
])

export const MediaLifecycleEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('engineStateChanged'),
    sequence: positiveProtocolInteger,
    previous: MediaEngineStateSchema,
    state: MediaEngineStateSchema,
    failure: Schema.optional(MediaLifecycleFailureSchema),
  }),
  Schema.Struct({
    type: Schema.Literal('roomStateChanged'),
    sequence: positiveProtocolInteger,
    revision: positiveProtocolInteger,
    state: Schema.Literals(['off', 'desired']),
  }),
  Schema.Struct({
    type: Schema.Literal('trackStateChanged'),
    sequence: positiveProtocolInteger,
    revision: positiveProtocolInteger,
    track: Schema.Literals(['microphone', 'camera', 'screen', 'output']),
    state: Schema.Literal('off'),
  }),
  Schema.Struct({
    type: Schema.Literal('fatalEngineFailure'),
    sequence: positiveProtocolInteger,
    failure: MediaLifecycleFailureSchema,
  }),
])

const DiagnosticMetricSchema = Schema.Struct({
  name: boundedString(64),
  value: Schema.Finite,
})
const DiagnosticImplementationFieldSchema = Schema.Struct({
  name: boundedString(64),
  value: boundedString(256, 0),
})
export const MediaLifecycleDiagnosticEventSchema = Schema.Struct({
  sequence: positiveProtocolInteger,
  timestampMs: protocolInteger,
  component: boundedString(64),
  operation: boundedString(128),
  code: boundedString(128),
  metrics: Schema.Array(DiagnosticMetricSchema).check(
    Schema.isMaxLength(MEDIA_LIFECYCLE_MAX_DIAGNOSTIC_METRICS),
  ),
  implementation: Schema.optional(
    Schema.Array(DiagnosticImplementationFieldSchema).check(
      Schema.isMaxLength(MEDIA_LIFECYCLE_MAX_DIAGNOSTIC_FIELDS),
    ),
  ),
})

export const MediaLifecyclePublicEventMessageSchema = Schema.Struct({
  type: Schema.Literal('event'),
  protocolVersion: Schema.Literal(MEDIA_LIFECYCLE_PROTOCOL_VERSION),
  event: MediaLifecycleEventSchema,
})

export const MediaLifecycleDiagnosticMessageSchema = Schema.Struct({
  type: Schema.Literal('diagnostic'),
  protocolVersion: Schema.Literal(MEDIA_LIFECYCLE_PROTOCOL_VERSION),
  event: MediaLifecycleDiagnosticEventSchema,
})

export const MediaLifecycleMessageSchema = Schema.Union([
  MediaLifecycleReadySchema,
  MediaLifecycleReplySchema,
  MediaLifecyclePublicEventMessageSchema,
  MediaLifecycleDiagnosticMessageSchema,
])

export type MediaLifecycleFailure = typeof MediaLifecycleFailureSchema.Type
export type MediaEngineState = typeof MediaEngineStateSchema.Type
export type EngineDesiredState = typeof EngineDesiredStateSchema.Type
export type MediaEngineSnapshot = typeof MediaEngineSnapshotSchema.Type
export type MediaDesiredStateAccepted = typeof MediaDesiredStateAcceptedSchema.Type
export type MediaAddonHandshake = typeof MediaAddonHandshakeSchema.Type
export type MediaAddonSnapshot = typeof MediaAddonSnapshotSchema.Type
export type MediaLifecycleReady = typeof MediaLifecycleReadySchema.Type
export type MediaLifecycleCommand = typeof MediaLifecycleCommandSchema.Type
export type MediaLifecycleRequest = typeof MediaLifecycleRequestSchema.Type
export type MediaLifecycleResult = typeof MediaLifecycleResultSchema.Type
export type MediaLifecycleReply = typeof MediaLifecycleReplySchema.Type
export type MediaLifecycleEvent = typeof MediaLifecycleEventSchema.Type
export type MediaLifecycleDiagnosticEvent = typeof MediaLifecycleDiagnosticEventSchema.Type
export type MediaLifecycleMessage = typeof MediaLifecycleMessageSchema.Type

export function isMediaLifecycleRequest(value: unknown): value is MediaLifecycleRequest {
  return Option.isSome(
    Schema.decodeUnknownOption(MediaLifecycleRequestSchema, {
      onExcessProperty: 'error',
    })(value),
  )
}

export function isMediaLifecycleMessage(value: unknown): value is MediaLifecycleMessage {
  return Option.isSome(
    Schema.decodeUnknownOption(MediaLifecycleMessageSchema, {
      onExcessProperty: 'error',
    })(value),
  )
}

export function mediaLifecycleFailure(
  code: string,
  message: string,
  stage: string,
  retryable = false,
): MediaLifecycleFailure {
  return {
    code: boundedText(code, 128),
    message: boundedText(redactMediaLifecycleText(message), 4_096),
    stage: boundedText(stage, 128),
    retryable,
  }
}

export function mediaLifecycleError(
  code: string,
  message: string,
  stage: string,
  retryable = false,
) {
  return MediaLifecycleError.make({
    failure: mediaLifecycleFailure(code, message, stage, retryable),
  })
}

export function failureFromUnknown(cause: unknown, stage: string): MediaLifecycleFailure {
  if (cause instanceof MediaLifecycleError) return cause.failure
  if (typeof cause === 'object' && cause !== null) {
    const decoded = Schema.decodeUnknownOption(MediaLifecycleFailureSchema)({
      code: Reflect.get(cause, 'code'),
      message: Reflect.get(cause, 'message'),
      stage: Reflect.get(cause, 'stage') ?? stage,
      retryable: Reflect.get(cause, 'retryable') ?? false,
    })
    if (Option.isSome(decoded)) {
      return {
        ...decoded.value,
        message: boundedText(redactMediaLifecycleText(decoded.value.message), 4_096),
      }
    }
  }
  return mediaLifecycleFailure(
    'media_lifecycle_failure',
    cause instanceof Error ? cause.message : 'Windows media lifecycle failed',
    stage,
  )
}

function boundedText(value: string, maximumLength: number) {
  const normalized = value.trim() || 'unknown'
  return normalized.slice(0, maximumLength)
}

export function redactMediaLifecycleText(value: string) {
  return value
    .replace(
      /\b(token|access_token|authorization)\s*[:=]\s*([^\s,;]+)/gi,
      '$1=[redacted]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:wss?|https?):\/\/[^\s,;]+/gi, '[redacted-url]')
    .slice(0, 4_096)
}
