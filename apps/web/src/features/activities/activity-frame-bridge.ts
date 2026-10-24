import {
  isProtocolMessage,
  LIMITS,
  PROTOCOL_TAG,
  PROTOCOL_VERSION,
  type ConnectMessage,
  type ErrorCode,
  type EventMap,
  type EventName,
  type ProtocolError,
  type RequestMap,
  type RequestMethod,
} from '@syrnike13/activity-sdk/protocol'
import { Option, Schema } from 'effect'

export type ActivityFrameHandlers = {
  readonly [M in RequestMethod]: (
    params: RequestMap[M]['params'],
  ) => Promise<RequestMap[M]['result']>
}

/** Error with an SDK error code; its message is safe to show to the application. */
export class ActivityFrameError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code)
    this.name = 'ActivityFrameError'
  }
}

/** Largest request envelope accepted from an application (state + overhead). */
export const MAX_ENVELOPE_BYTES = LIMITS.stateBytes + 4 * 1024

const OptionalVoid = Schema.Union([Schema.Undefined, Schema.Null])
const ScoreKey = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9_.-]{0,63}$/),
)
const ParticipantIds = Schema.Array(Schema.String).check(
  Schema.isMaxLength(99),
)

/** Params schema per request method; anything else is `invalid_request`. */
const PARAMS: { readonly [M in RequestMethod]: Schema.Decoder<unknown> } = {
  ready: OptionalVoid,
  send: Schema.Struct({
    payload: Schema.Unknown,
    to: Schema.optionalKey(ParticipantIds),
  }),
  setState: Schema.Struct({
    expectedVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    data: Schema.Unknown,
  }),
  getPlayerData: OptionalVoid,
  setPlayerData: Schema.Struct({
    data: Schema.Record(Schema.String, Schema.Unknown),
  }),
  submitScore: Schema.Struct({
    key: ScoreKey,
    value: Schema.Int,
    mode: Schema.Literals(['max', 'min', 'set']),
  }),
  getLeaderboard: Schema.Struct({
    key: ScoreKey,
    limit: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
    ),
    ascending: Schema.optionalKey(Schema.Boolean),
  }),
  authorize: Schema.Struct({
    scopes: Schema.Array(Schema.Literals(['identify', 'storage'])).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(2),
    ),
  }),
  openExternalLink: Schema.Struct({
    url: Schema.String.check(Schema.isMaxLength(2048)),
  }),
  leave: OptionalVoid,
  end: OptionalVoid,
}

function isRequestMethod(value: unknown): value is RequestMethod {
  return typeof value === 'string' && Object.hasOwn(PARAMS, value)
}

function serializedSize(value: unknown) {
  try {
    const json = JSON.stringify(value)
    return json === undefined ? 0 : new TextEncoder().encode(json).byteLength
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

type DecodedRequest =
  | { kind: 'request'; id: number; method: RequestMethod; params: unknown }
  | { kind: 'invalid'; id: number }
  | null

export function decodeRequestEnvelope(data: unknown): DecodedRequest {
  if (typeof data !== 'object' || data === null) return null
  const envelope = data as Record<string, unknown>
  if (envelope.kind !== 'request') return null
  const id = envelope.id
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) return null
  if (serializedSize(data) > MAX_ENVELOPE_BYTES) return { kind: 'invalid', id }
  if (!isRequestMethod(envelope.method)) return { kind: 'invalid', id }
  const decoded = Schema.decodeUnknownOption(PARAMS[envelope.method])(
    envelope.params,
  )
  if (Option.isNone(decoded)) return { kind: 'invalid', id }
  return {
    kind: 'request',
    id,
    method: envelope.method,
    params: decoded.value,
  }
}

function protocolError(error: unknown): ProtocolError {
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? (error.code as ErrorCode)
      : 'internal'
  // The message never carries internal details (tokens, URLs, stack traces).
  return { code, message: code }
}

type ActivityFrameBridgeOptions = {
  iframe: HTMLIFrameElement
  /** The Activity Origin, e.g. `https://app.activities.syrnike13.ru`. */
  origin: string
  handlers: ActivityFrameHandlers
  /** Called after every accepted handshake (first load and reloads). */
  onConnect?: () => void
}

/**
 * Host side of the Activity Frame protocol: accepts the application's `hello`
 * only from the iframe window and the Activity Origin, hands over one
 * MessagePort, and bridges requests to the handlers.
 */
export class ActivityFrameBridge {
  readonly #iframe: HTMLIFrameElement
  readonly #origin: string
  readonly #handlers: ActivityFrameHandlers
  readonly #onConnect: (() => void) | undefined
  readonly #window: Window
  #port: MessagePort | null = null
  #disposed = false

  constructor(options: ActivityFrameBridgeOptions) {
    this.#iframe = options.iframe
    this.#origin = options.origin
    this.#handlers = options.handlers
    this.#onConnect = options.onConnect
    // A popped-out stage lives in another window: the application's
    // `window.parent.postMessage` lands there, not in the main window.
    this.#window = options.iframe.ownerDocument.defaultView ?? window
    this.#window.addEventListener('message', this.#onWindowMessage)
  }

  get connected() {
    return this.#port !== null
  }

  emit<E extends EventName>(event: E, data: EventMap[E]) {
    this.#port?.postMessage({ kind: 'event', event, data })
  }

  dispose(reason?: EventMap['ended']['reason']) {
    if (this.#disposed) return
    this.#disposed = true
    this.#window.removeEventListener('message', this.#onWindowMessage)
    if (reason) this.emit('ended', { reason })
    this.#port?.close()
    this.#port = null
  }

  #onWindowMessage = (event: MessageEvent) => {
    const target = this.#iframe.contentWindow
    if (!target || event.source !== target) return
    if (event.origin !== this.#origin) return
    if (!isProtocolMessage(event.data, 'hello')) return
    this.#connect(target)
  }

  #connect(target: Window) {
    this.#port?.close()
    const channel = new MessageChannel()
    const port = channel.port1
    port.onmessage = (event) => this.#onPortMessage(port, event.data)
    this.#port = port
    const connect: ConnectMessage = {
      tag: PROTOCOL_TAG,
      v: PROTOCOL_VERSION,
      type: 'connect',
    }
    target.postMessage(connect, this.#origin, [channel.port2])
    this.#onConnect?.()
  }

  #onPortMessage(port: MessagePort, data: unknown) {
    if (port !== this.#port) return
    const request = decodeRequestEnvelope(data)
    if (!request) return
    if (request.kind === 'invalid') {
      this.#respondError(port, request.id, new ActivityFrameError('invalid_request'))
      return
    }
    const handler = this.#handlers[request.method] as (
      params: unknown,
    ) => Promise<unknown>
    handler(request.params ?? undefined).then(
      (result) => {
        if (port !== this.#port) return
        port.postMessage({ kind: 'response', id: request.id, result })
      },
      (error: unknown) => this.#respondError(port, request.id, error),
    )
  }

  #respondError(port: MessagePort, id: number, error: unknown) {
    if (port !== this.#port) return
    port.postMessage({ kind: 'response', id, error: protocolError(error) })
  }
}
