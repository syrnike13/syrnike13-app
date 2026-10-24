/**
 * Activity Frame protocol (ADR-0011).
 *
 * The application (inside the iframe) and the Activity Frame (syrnike13 client)
 * talk over one transferred MessagePort.
 *
 * Handshake:
 * 1. Application → `window.parent.postMessage(HelloMessage, '*')`.
 * 2. Frame checks `event.source === iframe.contentWindow` and
 *    `event.origin === activity origin`, then answers with
 *    `iframe.contentWindow.postMessage(ConnectMessage, activityOrigin, [port])`.
 * 3. Application accepts only a ConnectMessage whose `event.source === window.parent`
 *    and keeps the port. Everything else goes through the port as
 *    `PortMessage`. A newer ConnectMessage replaces the port (frame reconnect).
 *
 * The frame may recreate the iframe at any time; applications restore from
 * shared state.
 */

export const PROTOCOL_VERSION = 1
export const PROTOCOL_TAG = 'syrnike.activity'

export type HelloMessage = {
  readonly tag: typeof PROTOCOL_TAG
  readonly v: typeof PROTOCOL_VERSION
  readonly type: 'hello'
}

export type ConnectMessage = {
  readonly tag: typeof PROTOCOL_TAG
  readonly v: typeof PROTOCOL_VERSION
  readonly type: 'connect'
}

// ---------------------------------------------------------------------------
// Data

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

export type JsonObject = { readonly [key: string]: JsonValue }

export type ActivityUser = {
  readonly id: string
  readonly username: string
  readonly displayName: string
  /** Absolute URL or null when the user has no avatar. */
  readonly avatarUrl: string | null
}

export type ActivityParticipant = ActivityUser & {
  /** ISO 8601 */
  readonly joinedAt: string
}

export type SharedState = {
  /** 0 means the state was never written; `data` is then `null`. */
  readonly version: number
  readonly data: JsonValue
  readonly updatedBy: string | null
}

export type ThemeMode = 'light' | 'dark'

export type ActivityTheme = {
  readonly mode: ThemeMode
  /**
   * Semantic colour tokens of the client theme, e.g. `background`,
   * `foreground`, `card`, `primary`, `primary-foreground`, `muted`,
   * `muted-foreground`, `border`, `destructive`, `chart-1`…`chart-5`.
   * Values are CSS colours.
   */
  readonly tokens: Readonly<Record<string, string>>
}

/** How the Activity Frame currently presents the application. */
export type ActivityLayout = 'grid' | 'focus' | 'popout' | 'mini'

export type ActivityContext = {
  readonly protocolVersion: typeof PROTOCOL_VERSION
  readonly application: { readonly id: string; readonly name: string }
  readonly instance: {
    readonly id: string
    readonly channelId: string
    /** Server id; null for DM and group calls. */
    readonly serverId: string | null
  }
  readonly user: ActivityUser
  readonly participants: readonly ActivityParticipant[]
  readonly hostId: string
  readonly state: SharedState
  /** BCP 47, e.g. `ru` or `en`. */
  readonly locale: string
  readonly theme: ActivityTheme
  readonly layout: ActivityLayout
}

export type PlayerData = {
  /** JSON object, at most 16 KiB serialized; `{}` when never written. */
  readonly data: JsonObject
  /** Whether the last write came from the application backend. */
  readonly trusted: boolean
  readonly updatedAt: string | null
}

export type ScoreMode = 'max' | 'min' | 'set'

export type Score = {
  readonly user: ActivityUser
  readonly value: number
  readonly trusted: boolean
  readonly updatedAt: string
}

export type Leaderboard = {
  readonly key: string
  readonly entries: readonly Score[]
  readonly own: Score | null
}

export type AuthorizationScope = 'identify' | 'storage'

export type EndReason = 'ended' | 'empty' | 'application_unavailable' | 'left'

export type ConnectionStatus = 'connected' | 'reconnecting'

// ---------------------------------------------------------------------------
// Requests (application → frame)

export type RequestMap = {
  /** First request after the handshake. */
  ready: { params: void; result: ActivityContext }
  /** Relay to `to` (participant ids) or to every other participant. */
  send: {
    params: { readonly payload: JsonValue; readonly to?: readonly string[] }
    result: void
  }
  /** Compare-and-set; on conflict resolves with `ok: false` and the current state. */
  setState: {
    params: { readonly expectedVersion: number; readonly data: JsonValue }
    result: { readonly ok: boolean; readonly state: SharedState }
  }
  getPlayerData: { params: void; result: PlayerData }
  setPlayerData: { params: { readonly data: JsonObject }; result: PlayerData }
  submitScore: {
    params: { readonly key: string; readonly value: number; readonly mode: ScoreMode }
    result: Score
  }
  getLeaderboard: {
    params: {
      readonly key: string
      readonly limit?: number
      readonly ascending?: boolean
    }
    result: Leaderboard
  }
  /** Shows a consent dialog (skipped for first-party applications). */
  authorize: {
    params: { readonly scopes: readonly AuthorizationScope[] }
    result: { readonly code: string }
  }
  /** Asks the user to confirm and opens the URL outside the client. */
  openExternalLink: {
    params: { readonly url: string }
    result: { readonly opened: boolean }
  }
  /** Leave the instance; the frame closes afterwards. */
  leave: { params: void; result: void }
  /** End for everyone (host or channel managers). */
  end: { params: void; result: void }
}

export type RequestMethod = keyof RequestMap

export type ErrorCode =
  | 'invalid_request'
  | 'not_in_voice_channel'
  | 'missing_permission'
  | 'unknown_application'
  | 'already_running'
  | 'instance_not_found'
  | 'not_participant'
  | 'full'
  | 'not_allowed'
  | 'payload_too_large'
  | 'rate_limited'
  | 'version_conflict'
  | 'internal'
  /** The user dismissed a consent or confirmation dialog. */
  | 'cancelled'
  /** The gateway is disconnected; retry after `connection: connected`. */
  | 'disconnected'
  | 'timeout'
  | 'unsupported'

export type ProtocolError = { readonly code: ErrorCode; readonly message: string }

// ---------------------------------------------------------------------------
// Events (frame → application)

export type EventMap = {
  participants: {
    readonly participants: readonly ActivityParticipant[]
    readonly hostId: string
  }
  message: { readonly from: string; readonly payload: JsonValue }
  state: SharedState
  theme: ActivityTheme
  locale: { readonly locale: string }
  layout: { readonly layout: ActivityLayout }
  connection: { readonly status: ConnectionStatus }
  /** The instance ended or the user left; no further requests succeed. */
  ended: { readonly reason: EndReason }
}

export type EventName = keyof EventMap

// ---------------------------------------------------------------------------
// Port envelopes

export type RequestEnvelope<M extends RequestMethod = RequestMethod> = {
  readonly kind: 'request'
  readonly id: number
  readonly method: M
  readonly params: RequestMap[M]['params']
}

export type ResponseEnvelope =
  | { readonly kind: 'response'; readonly id: number; readonly result: unknown }
  | { readonly kind: 'response'; readonly id: number; readonly error: ProtocolError }

export type EventEnvelope<E extends EventName = EventName> = {
  readonly kind: 'event'
  readonly event: E
  readonly data: EventMap[E]
}

export type PortMessage = RequestEnvelope | ResponseEnvelope | EventEnvelope

export function isProtocolMessage(
  value: unknown,
  type: 'hello' | 'connect',
): value is HelloMessage | ConnectMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Record<string, unknown>
  return (
    message.tag === PROTOCOL_TAG &&
    message.v === PROTOCOL_VERSION &&
    message.type === type
  )
}

/** Limits enforced by the backend; the SDK checks them before sending. */
export const LIMITS = {
  messageBytes: 16 * 1024,
  stateBytes: 64 * 1024,
  playerDataBytes: 16 * 1024,
  messagesPerSecond: 30,
} as const
