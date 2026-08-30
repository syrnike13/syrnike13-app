import { Option, Schema } from 'effect'

export const MEDIA_LIFECYCLE_PROTOCOL_VERSION = 1
export const MEDIA_LIFECYCLE_MAX_PENDING_REQUESTS = 16
export const MEDIA_LIFECYCLE_HANDSHAKE_TIMEOUT_MS = 5_000
export const MEDIA_LIFECYCLE_PING_TIMEOUT_MS = 1_000
export const MEDIA_LIFECYCLE_SHUTDOWN_TIMEOUT_MS = 1_000
export const MEDIA_LIFECYCLE_OUTER_SHUTDOWN_MS = 1_500

const nonEmptyString = (maximumLength = 4_096) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(maximumLength),
  )

export const MediaLifecycleFailureSchema = Schema.Struct({
  code: nonEmptyString(128),
  message: nonEmptyString(),
  stage: nonEmptyString(128),
  retryable: Schema.Boolean,
})

export class MediaLifecycleError extends Schema.TaggedErrorClass<
  MediaLifecycleError
>()('MediaLifecycleError', {
  failure: MediaLifecycleFailureSchema,
}) {}

export const MediaEngineStateSchema = Schema.Literals([
  'stopped',
  'starting',
  'running',
  'stopping',
  'failed',
])

const MediaBuildIdentitySchema = Schema.Struct({
  commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/i)),
  napi: Schema.String.check(Schema.isPattern(/^\d+$/)),
})

export const MediaAddonHandshakeSchema = Schema.Struct({
  protocolVersion: Schema.Int,
  engineState: MediaEngineStateSchema,
  build: MediaBuildIdentitySchema,
})

export const MediaAddonPingSchema = Schema.Struct({
  ok: Schema.Literal(true),
  engineState: Schema.Literal('running'),
})

export const MediaAddonShutdownSchema = Schema.Struct({
  ok: Schema.Literal(true),
  engineState: Schema.Literal('stopped'),
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
  Schema.Struct({ type: Schema.Literal('ping') }),
  Schema.Struct({ type: Schema.Literal('shutdown') }),
])

export const MediaLifecycleRequestSchema = Schema.Struct({
  type: Schema.Literal('request'),
  requestId: nonEmptyString(256),
  hostEpoch: Schema.Int.check(Schema.isGreaterThan(0)),
  command: MediaLifecycleCommandSchema,
})

export const MediaLifecycleReplySchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('reply'),
    requestId: nonEmptyString(256),
    ok: Schema.Literal(true),
    result: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({
    type: Schema.Literal('reply'),
    requestId: nonEmptyString(256),
    ok: Schema.Literal(false),
    failure: MediaLifecycleFailureSchema,
  }),
])

export const MediaLifecycleEventSchema = Schema.Struct({
  type: Schema.Literal('engineStateChanged'),
  sequence: Schema.Natural,
  previous: MediaEngineStateSchema,
  state: MediaEngineStateSchema,
  failure: Schema.optional(MediaLifecycleFailureSchema),
})

export const MediaLifecycleMessageSchema = Schema.Union([
  MediaLifecycleReadySchema,
  MediaLifecycleReplySchema,
  Schema.Struct({
    type: Schema.Literal('event'),
    event: MediaLifecycleEventSchema,
  }),
])

export type MediaLifecycleFailure = typeof MediaLifecycleFailureSchema.Type
export type MediaEngineState = typeof MediaEngineStateSchema.Type
export type MediaAddonHandshake = typeof MediaAddonHandshakeSchema.Type
export type MediaLifecycleReady = typeof MediaLifecycleReadySchema.Type
export type MediaLifecycleCommand = typeof MediaLifecycleCommandSchema.Type
export type MediaLifecycleRequest = typeof MediaLifecycleRequestSchema.Type
export type MediaLifecycleReply = typeof MediaLifecycleReplySchema.Type
export type MediaLifecycleEvent = typeof MediaLifecycleEventSchema.Type
export type MediaLifecycleMessage = typeof MediaLifecycleMessageSchema.Type

export function isMediaLifecycleRequest(
  value: unknown,
): value is MediaLifecycleRequest {
  return Option.isSome(
    Schema.decodeUnknownOption(MediaLifecycleRequestSchema)(value),
  )
}

export function isMediaLifecycleMessage(
  value: unknown,
): value is MediaLifecycleMessage {
  return Option.isSome(
    Schema.decodeUnknownOption(MediaLifecycleMessageSchema)(value),
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
    message: redactSensitiveText(message),
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

export function failureFromUnknown(
  cause: unknown,
  stage: string,
): MediaLifecycleFailure {
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
        message: redactSensitiveText(decoded.value.message),
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

function redactSensitiveText(value: string) {
  return value
    .replace(
      /\b(token|access_token|authorization)\s*[:=]\s*([^\s,;]+)/gi,
      '$1=[redacted]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:wss?|https?):\/\/[^\s,;]+/gi, '[redacted-url]')
    .slice(0, 4_096)
}

