import { NativeInputEventSchema } from '@syrnike13/platform'
import { Option, Schema } from 'effect'

export const NATIVE_RUNTIME_CONTRACT_VERSION = 10
export const NATIVE_RUNTIME_MAX_PENDING_REQUESTS = 256

const nonEmptyString = (maximumLength = 4_096) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(maximumLength),
  )

export const NativeRuntimeErrorSchema = Schema.Struct({
  code: nonEmptyString(128),
  message: nonEmptyString(),
  stage: Schema.optional(nonEmptyString(128)),
  retryable: Schema.Boolean,
})

const NativeRuntimeBuildSchema = Schema.Record(Schema.String, Schema.String)

const NativeRuntimeReadySchema = Schema.Struct({
  type: Schema.Literal('ready'),
  contractVersion: Schema.Int,
  runtime: Schema.Literals(['hotkey', 'overlay', 'invalid']),
  capabilities: Schema.UniqueArray(nonEmptyString(128)).check(
    Schema.isMaxLength(32),
  ),
  build: NativeRuntimeBuildSchema,
})

export const NativeRuntimeReplySchema = Schema.Union([
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
    error: NativeRuntimeErrorSchema,
  }),
])

const UncorrelatedNativeRuntimeReplySchema = Schema.Struct({
  type: Schema.Literal('reply'),
  requestId: Schema.optional(Schema.Never),
  ok: Schema.Boolean,
})

export type NativeRuntimeKind = 'hotkey' | 'overlay'
export type NativeRuntimeBuild = typeof NativeRuntimeBuildSchema.Type
export type NativeRuntimeReady = typeof NativeRuntimeReadySchema.Type
export type NativeRuntimeReply = typeof NativeRuntimeReplySchema.Type
export type NativeRuntimeError = typeof NativeRuntimeErrorSchema.Type

export const HooksRuntimeCommandSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('startHotkeys') }),
  Schema.Struct({ type: Schema.Literal('stopHotkeys') }),
  Schema.Struct({ type: Schema.Literal('startOverlay') }),
  Schema.Struct({ type: Schema.Literal('stopOverlay') }),
  Schema.Struct({ type: Schema.Literal('probeHooksRuntime') }),
  Schema.Struct({ type: Schema.Literal('shutdown') }),
])

export const NativeRuntimeCommandSchema = HooksRuntimeCommandSchema
export const NativeRuntimeLaneSchema = Schema.Literals([
  'runtime',
  'hotkey',
  'overlay',
])

export type HooksRuntimeCommand = typeof HooksRuntimeCommandSchema.Type
export type NativeRuntimeCommand = typeof NativeRuntimeCommandSchema.Type
export type NativeRuntimeLane = typeof NativeRuntimeLaneSchema.Type

export function nativeRuntimeCommandLane(
  command: NativeRuntimeCommand,
): NativeRuntimeLane {
  switch (command.type) {
    case 'shutdown':
      return 'runtime'
    case 'startHotkeys':
    case 'stopHotkeys':
      return 'hotkey'
    case 'startOverlay':
    case 'stopOverlay':
    case 'probeHooksRuntime':
      return 'overlay'
  }
}

const NativeRuntimeDiagnosticContextSchema = Schema.Struct({
  actionId: nonEmptyString(128),
  hostEpoch: Schema.Int.check(Schema.isGreaterThan(0)),
})

export const NativeRuntimeRequestSchema = Schema.Struct({
  type: Schema.Literal('request'),
  requestId: nonEmptyString(256),
  lane: NativeRuntimeLaneSchema,
  hostEpoch: Schema.Int.check(Schema.isGreaterThan(0)),
  command: NativeRuntimeCommandSchema,
  diagnostic: Schema.optional(NativeRuntimeDiagnosticContextSchema),
}).check(
  Schema.makeFilter(
    (request) =>
      request.lane === nativeRuntimeCommandLane(request.command) ||
      (request.command.type === 'probeHooksRuntime' &&
        request.lane === 'hotkey'),
    { expected: 'a supervision lane matching the hooks command' },
  ),
)

export type NativeRuntimeDiagnosticContext =
  typeof NativeRuntimeDiagnosticContextSchema.Type
export type NativeRuntimeRequest = typeof NativeRuntimeRequestSchema.Type

const runtimeEventFields = {
  sequence: Schema.Natural,
}

const RuntimeErrorEventSchema = Schema.Struct({
  type: Schema.Literal('runtimeError'),
  ...runtimeEventFields,
  error: NativeRuntimeErrorSchema,
})

const InputEventSchema = Schema.Struct({
  type: Schema.Literal('input'),
  ...runtimeEventFields,
  input: NativeInputEventSchema,
})

const ForegroundWindowEventSchema = Schema.Struct({
  type: Schema.Literal('foregroundWindow'),
  ...runtimeEventFields,
  window: Schema.Union([
    Schema.Null,
    Schema.Struct({
      pid: Schema.Int,
      processName: Schema.String.check(Schema.isMaxLength(4_096)),
      processPath: Schema.Union([
        Schema.Null,
        Schema.String.check(Schema.isMaxLength(32_768)),
      ]),
      title: Schema.String.check(Schema.isMaxLength(32_768)),
      className: Schema.String.check(Schema.isMaxLength(4_096)),
      visible: Schema.Boolean,
      fullscreenLike: Schema.Boolean,
      bounds: Schema.Struct({
        x: Schema.Finite,
        y: Schema.Finite,
        width: Schema.Finite,
        height: Schema.Finite,
      }),
    }),
  ]),
})

export const NativeRuntimeEventSchema = Schema.Union([
  InputEventSchema,
  ForegroundWindowEventSchema,
  RuntimeErrorEventSchema,
])

export type NativeRuntimeEvent = typeof NativeRuntimeEventSchema.Type
export type HooksRuntimeEvent = NativeRuntimeEvent
export type OverlayForegroundWindow = Extract<
  NativeRuntimeEvent,
  { readonly type: 'foregroundWindow' }
>['window']

export const NativeRuntimeMessageSchema = Schema.Union([
  NativeRuntimeReadySchema,
  NativeRuntimeReplySchema,
  Schema.Struct({
    type: Schema.Literal('event'),
    event: NativeRuntimeEventSchema,
  }),
])

export type NativeRuntimeMessage = typeof NativeRuntimeMessageSchema.Type
export type NativeRuntimeEventMessage = Extract<
  NativeRuntimeMessage,
  { readonly type: 'event' }
>

export function isNativeRuntimeCommand(
  value: unknown,
): value is NativeRuntimeCommand {
  return Option.isSome(
    Schema.decodeUnknownOption(NativeRuntimeCommandSchema)(value),
  )
}

export function isNativeRuntimeRequest(
  value: unknown,
): value is NativeRuntimeRequest {
  return Option.isSome(
    Schema.decodeUnknownOption(NativeRuntimeRequestSchema)(value),
  )
}

export function isNativeRuntimeReady(
  value: unknown,
): value is NativeRuntimeReady {
  return Option.isSome(
    Schema.decodeUnknownOption(NativeRuntimeReadySchema)(value),
  )
}

export function isNativeRuntimeReply(
  value: unknown,
): value is NativeRuntimeReply {
  return Option.isSome(
    Schema.decodeUnknownOption(NativeRuntimeReplySchema)(value),
  )
}

export function isUncorrelatedNativeRuntimeReply(
  value: unknown,
): value is Record<string, unknown> & {
  type: 'reply'
  requestId?: undefined
  ok: boolean
} {
  return Option.isSome(
    Schema.decodeUnknownOption(UncorrelatedNativeRuntimeReplySchema)(value),
  )
}

export function isNativeRuntimeEvent(
  value: unknown,
): value is NativeRuntimeEvent {
  return Option.isSome(
    Schema.decodeUnknownOption(NativeRuntimeEventSchema)(value),
  )
}

export function isNativeRuntimeMessage(
  value: unknown,
): value is NativeRuntimeMessage {
  return Option.isSome(
    Schema.decodeUnknownOption(NativeRuntimeMessageSchema)(value),
  )
}

export function nativeRuntimeError(
  code: string,
  message: string,
  options: Partial<Omit<NativeRuntimeError, 'code' | 'message'>> = {},
): NativeRuntimeError {
  return {
    code,
    message,
    retryable: options.retryable ?? false,
    stage: options.stage,
  }
}

export function sanitizeRuntimeError(error: unknown): NativeRuntimeError {
  const decoded = Schema.decodeUnknownOption(NativeRuntimeErrorSchema)(error)
  if (Option.isSome(decoded)) {
    return {
      ...decoded.value,
      message: redactSensitiveText(decoded.value.message),
      stage: decoded.value.stage
        ? redactSensitiveText(decoded.value.stage).slice(0, 128)
        : undefined,
    }
  }
  const message = error instanceof Error ? error.message : 'Native runtime failed'
  return nativeRuntimeError('native_failure', redactSensitiveText(message))
}

export function redactSensitiveText(
  value: string,
  maximumLength = 4_096,
) {
  return value
    .replace(
      /\b(token|access_token|authorization)\s*[:=]\s*([^\s,;]+)/gi,
      '$1=[redacted]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:wss?|https?):\/\/[^\s,;]+/gi, '[redacted-url]')
    .replace(
      /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
      '[redacted]',
    )
    .slice(0, maximumLength)
}
