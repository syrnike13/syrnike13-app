import { Option, Schema } from 'effect'

import {
  MEDIA_LIFECYCLE_GENERATED_VERSION,
  MEDIA_LIFECYCLE_PROTOCOL_LIMITS,
  MEDIA_LIFECYCLE_SCHEMA_SHA256,
  MEDIA_UTILITY_GENERATED_BOOTSTRAP_MESSAGE,
} from './protocol.generated'

export { MEDIA_LIFECYCLE_SCHEMA_SHA256 }

export const MEDIA_LIFECYCLE_PROTOCOL_VERSION = MEDIA_LIFECYCLE_GENERATED_VERSION
// Private Electron parent/utility synchronization. This is intentionally not
// part of the public native lifecycle protocol.
export const MEDIA_UTILITY_BOOTSTRAP_MESSAGE =
  MEDIA_UTILITY_GENERATED_BOOTSTRAP_MESSAGE
export const MEDIA_LIFECYCLE_CONTROL_QUEUE_CAPACITY =
  MEDIA_LIFECYCLE_PROTOCOL_LIMITS.controlQueueCapacity
export const MEDIA_LIFECYCLE_MAX_PENDING_REQUESTS =
  MEDIA_LIFECYCLE_CONTROL_QUEUE_CAPACITY
export const MEDIA_LIFECYCLE_EVENT_QUEUE_CAPACITY =
  MEDIA_LIFECYCLE_PROTOCOL_LIMITS.eventQueueCapacity
export const MEDIA_LIFECYCLE_MAX_REQUEST_ID_LENGTH =
  MEDIA_LIFECYCLE_PROTOCOL_LIMITS.maximumRequestIdLength
export const MEDIA_LIFECYCLE_MAX_IDENTIFIER_LENGTH =
  MEDIA_LIFECYCLE_PROTOCOL_LIMITS.maximumIdentifierLength
export const MEDIA_LIFECYCLE_MAX_REMOTE_VIDEO_DEMANDS =
  MEDIA_LIFECYCLE_PROTOCOL_LIMITS.maximumRemoteVideoDemands
export const MEDIA_LIFECYCLE_MAX_DIAGNOSTIC_METRICS =
  MEDIA_LIFECYCLE_PROTOCOL_LIMITS.maximumDiagnosticMetrics
export const MEDIA_LIFECYCLE_MAX_DIAGNOSTIC_FIELDS =
  MEDIA_LIFECYCLE_PROTOCOL_LIMITS.maximumDiagnosticFields
export const MEDIA_LIFECYCLE_MAX_DEADLINE_MS =
  MEDIA_LIFECYCLE_PROTOCOL_LIMITS.maximumRequestDeadlineMs
export const MEDIA_LIFECYCLE_ROOM_CONNECT_TIMEOUT_MS =
  MEDIA_LIFECYCLE_PROTOCOL_LIMITS.roomConnectDeadlineMs
export const MEDIA_LIFECYCLE_ROOM_DISCONNECT_TIMEOUT_MS =
  MEDIA_LIFECYCLE_PROTOCOL_LIMITS.roomDisconnectDeadlineMs
export const MEDIA_LIFECYCLE_ROOM_CANCELLATION_TIMEOUT_MS =
  MEDIA_LIFECYCLE_PROTOCOL_LIMITS.roomCancellationDeadlineMs
export const MEDIA_LIFECYCLE_START_TIMEOUT_MS =
  MEDIA_LIFECYCLE_PROTOCOL_LIMITS.startDeadlineMs
export const MEDIA_LIFECYCLE_HANDSHAKE_TIMEOUT_MS = 5_000
export const MEDIA_LIFECYCLE_PING_TIMEOUT_MS =
  MEDIA_LIFECYCLE_PROTOCOL_LIMITS.pingDeadlineMs
export const MEDIA_LIFECYCLE_SHUTDOWN_TIMEOUT_MS =
  MEDIA_LIFECYCLE_PROTOCOL_LIMITS.shutdownDeadlineMs
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
  code: boundedString(MEDIA_LIFECYCLE_PROTOCOL_LIMITS.maximumFailureCodeLength),
  message: boundedString(
    MEDIA_LIFECYCLE_PROTOCOL_LIMITS.maximumFailureMessageLength,
  ),
  stage: boundedString(MEDIA_LIFECYCLE_PROTOCOL_LIMITS.maximumFailureStageLength),
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
  protocolSchemaSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/i)),
})

export const RoomIntentSchema = Schema.Struct({
  roomId: identifierSchema,
  participantIdentity: identifierSchema,
  credentialLeaseId: identifierSchema,
})

export const MediaCredentialLeaseSchema = Schema.Struct({
  leaseId: identifierSchema,
  serverUrl: boundedString(
    MEDIA_LIFECYCLE_PROTOCOL_LIMITS.maximumServerUrlLength,
  ).check(Schema.isPattern(/^wss?:\/\//)),
  accessToken: boundedString(
    MEDIA_LIFECYCLE_PROTOCOL_LIMITS.maximumAccessTokenLength,
  ),
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
  roomState: Schema.Literals([
    'off', 'connecting', 'connected', 'disconnecting', 'failed',
  ]),
  roomFailure: Schema.optional(MediaLifecycleFailureSchema),
  tracks: TrackPublicStateSchema,
})

export const MediaDesiredStateAcceptedSchema = Schema.Struct({
  type: Schema.Literal('desiredStateAccepted'),
  acceptedRevision: positiveProtocolInteger,
  disposition: Schema.Literals(['accepted', 'duplicate']),
})

export const MediaCredentialLeaseInstalledSchema = Schema.Struct({
  type: Schema.Literal('credentialLeaseInstalled'),
  leaseId: identifierSchema,
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
    type: Schema.Literal('installCredentialLease'),
    lease: MediaCredentialLeaseSchema,
  }),
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
  MediaCredentialLeaseInstalledSchema,
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
    state: Schema.Literals([
      'off', 'connecting', 'connected', 'disconnecting', 'failed',
    ]),
    failure: Schema.optional(MediaLifecycleFailureSchema),
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
  name: boundedString(MEDIA_LIFECYCLE_PROTOCOL_LIMITS.maximumDiagnosticNameLength),
  value: Schema.Finite,
})
const DiagnosticImplementationFieldSchema = Schema.Struct({
  name: boundedString(MEDIA_LIFECYCLE_PROTOCOL_LIMITS.maximumDiagnosticNameLength),
  value: boundedString(
    MEDIA_LIFECYCLE_PROTOCOL_LIMITS.maximumDiagnosticValueLength,
    0,
  ),
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
export type MediaCredentialLease = typeof MediaCredentialLeaseSchema.Type
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
    code: boundedText(
      code,
      MEDIA_LIFECYCLE_PROTOCOL_LIMITS.maximumFailureCodeLength,
    ),
    message: boundedText(
      redactMediaLifecycleText(message),
      MEDIA_LIFECYCLE_PROTOCOL_LIMITS.maximumFailureMessageLength,
    ),
    stage: boundedText(
      stage,
      MEDIA_LIFECYCLE_PROTOCOL_LIMITS.maximumFailureStageLength,
    ),
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
        message: boundedText(
          redactMediaLifecycleText(decoded.value.message),
          MEDIA_LIFECYCLE_PROTOCOL_LIMITS.maximumFailureMessageLength,
        ),
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
    .slice(0, MEDIA_LIFECYCLE_PROTOCOL_LIMITS.maximumFailureMessageLength)
}
