import {
  GatewayServerEventSchema,
  type GatewayServerEvent,
} from '@syrnike13/api-types/gateway-schema'
import { Effect, Fiber, Layer, ManagedRuntime, Option, Schedule, Schema } from 'effect'

export type GatewayState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'

type GatewayEvent = Readonly<Record<string, unknown>>

const GatewayEventSchema = Schema.Record(Schema.String, Schema.Unknown)
const GatewayJsonEventSchema = Schema.fromJsonString(GatewayEventSchema)

type ReliableQueueItem = {
  event: Record<string, unknown>
  key?: string
}

type GatewayMigration = {
  ws: WebSocket
  pending: string[]
}

type StateListener = (state: GatewayState) => void
type EventListener = (event: GatewayEvent) => void
type ServerEventListener = (event: GatewayServerEvent) => void

const READY_FIELDS = [
  'users',
  'servers',
  'channels',
  'members',
  'emojis',
  'voice_states',
  'voice_calls',
  'activities',
  'channel_unreads',
  'authorization',
] as const

const HEARTBEAT_INTERVAL_MS = 30_000
const HEARTBEAT_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * 2
const RECONNECT_BASE_MS = 500
// Deploy restarts take seconds, so keep retries frequent for the first minute
// and back off to the long cap only for real outages.
const RECONNECT_FAST_CAP_MS = 5_000
const RECONNECT_FAST_ATTEMPTS = 15
const RECONNECT_MAX_MS = 30_000
const RELIABLE_QUEUE_MAX = 64
// Events the old connection delivered are skipped on the new one for this long
// after a migration.
const MIGRATION_DEDUPE_MS = 30_000
// serde writes the tag first, so Ready is recognised without parsing a large
// payload twice.
const READY_MESSAGE_PATTERN = /^{"type":"Ready"/

/**
 * Exponential reconnect delay with jitter in the upper half of each step, so
 * clients dropped by the same restart do not reconnect in one burst.
 */
export function gatewayReconnectDelayMs(attempt: number, random = Math.random) {
  const cap =
    attempt < RECONNECT_FAST_ATTEMPTS ? RECONNECT_FAST_CAP_MS : RECONNECT_MAX_MS
  const step = Math.min(RECONNECT_BASE_MS * 2 ** attempt, cap)
  return Math.round(step / 2 + (step / 2) * random())
}

/** What the gateway needs from the app it runs in. */
export type GatewayEnvironment = {
  /** The `client` the server keys sessions by: `web`, `desktop`, `mobile`. */
  clientKind(): string
  /**
   * Calls `wake` whenever the app may have missed events (back in the
   * foreground, network restored) and returns a cleanup function.
   */
  watchWake(wake: () => void): () => void
}

function gatewayErrorIsFatal(event: GatewayEvent) {
  return event.type === 'Error' && event.fatal !== false
}

/**
 * WebSocket-клиент syrnike13 (протокол v1, JSON) с auto-reconnect и heartbeat.
 */
export class EventsGateway {
  readonly #runtime = ManagedRuntime.make(Layer.empty)
  #ws: WebSocket | undefined
  #state: GatewayState = 'idle'
  #stateListeners = new Set<StateListener>()
  #eventListeners = new Set<EventListener>()
  #serverEventListeners = new Set<ServerEventListener>()
  #wsUrl: string | undefined
  #token: string | undefined
  #autoReconnectEnabled = false
  #manualClose = false
  #reconnectAttempt = 0
  #reconnectFiber: Fiber.Fiber<void, never> | undefined
  #heartbeatFiber: Fiber.Fiber<void, never> | undefined
  #heartbeatTimeoutFiber: Fiber.Fiber<void, never> | undefined
  #lastMessageAt = 0
  #stopWatchingWake: (() => void) | undefined
  #reliableQueue: ReliableQueueItem[] = []
  #migration: GatewayMigration | undefined
  #beforeSwap = new Map<string, number>()
  #dedupeUntil = 0

  readonly #environment: GatewayEnvironment

  constructor(environment: GatewayEnvironment) {
    this.#environment = environment
  }

  get state() {
    return this.#state
  }

  subscribeState(listener: StateListener) {
    this.#stateListeners.add(listener)
    listener(this.#state)
    return () => this.#stateListeners.delete(listener)
  }

  subscribeEvents(listener: EventListener) {
    this.#eventListeners.add(listener)
    return () => this.#eventListeners.delete(listener)
  }

  subscribeServerEvents(listener: ServerEventListener) {
    this.#serverEventListeners.add(listener)
    return () => this.#serverEventListeners.delete(listener)
  }

  enableAutoReconnect(wsUrl: string, token: string) {
    this.#autoReconnectEnabled = true
    this.#manualClose = false
    this.#wsUrl = wsUrl
    this.#token = token
    this.#installLifecycleListeners()
  }

  disableAutoReconnect() {
    this.#autoReconnectEnabled = false
    this.#manualClose = true
    this.#clearReconnectTimer()
    this.#reliableQueue = []
    this.#removeLifecycleListeners()
    this.#closeSocket()
    this.#setState('idle')
  }

  connect(wsUrl: string, token: string) {
    this.#wsUrl = wsUrl
    this.#token = token
    this.#openSocket(false)
  }

  reconnect() {
    if (!this.#wsUrl || !this.#token) return
    this.#reconnectAttempt = 0
    this.#clearReconnectTimer()
    this.#openSocket(true)
  }

  disconnect() {
    this.disableAutoReconnect()
  }

  send(event: Record<string, unknown>) {
    this.#sendOpen(event)
  }

  sendReliable(event: Record<string, unknown>, key?: string) {
    if (this.#sendConnected(event)) return
    this.#queueReliable(event, key)
  }

  beginTyping(channelId: string) {
    this.send({ type: 'BeginTyping', channel: channelId })
  }

  endTyping(channelId: string) {
    this.send({ type: 'EndTyping', channel: channelId })
  }

  userActivity() {
    this.#sendConnected({ type: 'UserActivity' })
  }

  #socketUrl() {
    const wsUrl = this.#wsUrl
    const token = this.#token
    if (!wsUrl || !token) return undefined

    const url = new URL(wsUrl)
    url.searchParams.set('version', '1')
    url.searchParams.set('format', 'json')
    url.searchParams.set('token', token)
    url.searchParams.set('client', this.#environment.clientKind())
    for (const field of READY_FIELDS) {
      url.searchParams.append('ready', field)
    }
    return url
  }

  #openSocket(isReconnect: boolean) {
    const url = this.#socketUrl()
    if (!url) return

    this.#closeSocket()
    this.#clearDedupe()
    this.#manualClose = false
    this.#setState(isReconnect ? 'reconnecting' : 'connecting')

    const ws = new WebSocket(url)
    this.#ws = ws
    this.#attachPrimary(ws)
  }

  #attachPrimary(ws: WebSocket) {
    ws.onopen = () => {
      if (this.#ws !== ws) return
      this.#touchActivity()
      this.#startHeartbeat()
      ws.send(JSON.stringify({ type: 'Ping', data: Date.now() }))
    }

    ws.onmessage = (message) => {
      if (this.#ws !== ws || typeof message.data !== 'string') return
      this.#touchActivity()
      if (this.#migration) this.#rememberBeforeSwap(message.data)
      else if (this.#isDuplicateAfterSwap(message.data)) return
      this.#handleMessage(message.data)
    }

    ws.onerror = () => {
      if (this.#ws !== ws) return
      if (this.#state !== 'connected') {
        this.#setState('disconnected')
      }
    }

    ws.onclose = () => {
      if (this.#ws !== ws) return
      this.#ws = undefined
      this.#stopHeartbeat()
      // The old gateway closed before the new connection was Ready; carry on
      // with the new connection as an ordinary reconnect.
      if (this.#migration) {
        this.#adoptMigrationAsReconnect()
        return
      }
      this.#handleUnexpectedClose()
    }
  }

  #handleMessage(data: string) {
    const decoded = Schema.decodeUnknownOption(GatewayJsonEventSchema)(data)
    if (Option.isNone(decoded)) return
    const event = decoded.value

    if (event.type === 'Ping') {
      this.send({ type: 'Pong', data: event.data })
      return
    }

    if (event.type === 'Pong') {
      return
    }

    if (event.type === 'Reconnect') {
      this.#startMigration()
      return
    }

    this.#eventListeners.forEach((listener) => listener(event))
    const serverEvent = Schema.decodeUnknownOption(GatewayServerEventSchema)(
      event,
    )
    if (Option.isSome(serverEvent)) {
      this.#serverEventListeners.forEach((listener) =>
        listener(serverEvent.value),
      )
    }

    if (gatewayErrorIsFatal(event)) {
      if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
        this.#ws.close()
      } else {
        this.#handleUnexpectedClose()
      }
      return
    }

    if (event.type === 'Ready') {
      this.#reconnectAttempt = 0
      this.#clearReconnectTimer()
      this.#setState('connected')
      this.#flushReliableQueue()
    }
  }

  /**
   * The gateway process is shutting down. Open a second connection, keep using
   * the current one until the new one is Ready, then switch, so no events are
   * missed and the app never sees the gateway as disconnected.
   */
  #startMigration() {
    if (this.#migration || this.#state !== 'connected') return
    const url = this.#socketUrl()
    if (!url) return

    const ws = new WebSocket(url)
    const migration: GatewayMigration = { ws, pending: [] }
    this.#migration = migration
    this.#beforeSwap.clear()

    ws.onopen = () => {
      if (this.#migration !== migration) return
      ws.send(JSON.stringify({ type: 'Ping', data: Date.now() }))
    }
    ws.onmessage = (message) => {
      if (this.#migration !== migration || typeof message.data !== 'string')
        return
      migration.pending.push(message.data)
      if (READY_MESSAGE_PATTERN.test(message.data)) {
        this.#completeMigration()
      }
    }
    ws.onerror = null
    ws.onclose = () => {
      if (this.#migration === migration) this.#migration = undefined
    }
  }

  #detachPrimary() {
    const previous = this.#ws
    this.#ws = undefined
    this.#stopHeartbeat()
    if (!previous) return
    previous.onopen = null
    previous.onmessage = null
    previous.onerror = null
    previous.onclose = null
    previous.close()
  }

  /**
   * The new connection is Ready. The old connection delivered every event up to
   * now, so the app state is current: the new connection's Ready (a snapshot
   * taken before it subscribed) is not replayed, and events both connections
   * delivered are skipped on the new one.
   */
  #completeMigration() {
    const migration = this.#migration
    if (!migration) return
    this.#migration = undefined

    this.#detachPrimary()
    this.#ws = migration.ws
    this.#attachPrimary(migration.ws)
    this.#touchActivity()
    this.#startHeartbeat()
    this.#dedupeUntil = Date.now() + MIGRATION_DEDUPE_MS
    this.#flushReliableQueue()
  }

  /**
   * The old connection closed before the new one was Ready, so events may have
   * been missed: continue on the new connection as a reconnect and let its
   * Ready replace the state.
   */
  #adoptMigrationAsReconnect() {
    const migration = this.#migration
    if (!migration) return
    this.#migration = undefined
    this.#clearDedupe()

    const ws = migration.ws
    if (ws.readyState !== WebSocket.OPEN) {
      // Still connecting or already failed: a normal reconnect has timeouts
      // and backoff that a pending socket lacks.
      ws.onopen = null
      ws.onmessage = null
      ws.onclose = null
      ws.close()
      this.#handleUnexpectedClose()
      return
    }

    this.#ws = ws
    this.#attachPrimary(ws)
    this.#touchActivity()
    this.#startHeartbeat()
    this.#setState('reconnecting')
    for (const data of migration.pending) {
      if (this.#ws !== ws) return
      this.#handleMessage(data)
    }
  }

  #cancelMigration() {
    const migration = this.#migration
    if (!migration) return
    this.#migration = undefined
    migration.ws.onopen = null
    migration.ws.onmessage = null
    migration.ws.onclose = null
    migration.ws.close()
  }

  #clearDedupe() {
    this.#beforeSwap.clear()
    this.#dedupeUntil = 0
  }

  #rememberBeforeSwap(data: string) {
    this.#beforeSwap.set(data, (this.#beforeSwap.get(data) ?? 0) + 1)
  }

  /** Both connections deliver events published while they overlap. */
  #isDuplicateAfterSwap(data: string) {
    if (this.#beforeSwap.size === 0) return false
    if (Date.now() > this.#dedupeUntil) {
      this.#beforeSwap.clear()
      return false
    }
    const count = this.#beforeSwap.get(data)
    if (!count) return false
    if (count === 1) this.#beforeSwap.delete(data)
    else this.#beforeSwap.set(data, count - 1)
    return true
  }

  #handleUnexpectedClose() {
    if (this.#manualClose || !this.#autoReconnectEnabled) {
      if (!this.#manualClose && this.#state !== 'idle') {
        this.#setState('disconnected')
      }
      return
    }
    this.#scheduleReconnect()
  }

  #scheduleReconnect() {
    if (!this.#autoReconnectEnabled || !this.#wsUrl || !this.#token) return
    if (this.#reconnectFiber !== undefined) return

    this.#setState('reconnecting')

    const delay = gatewayReconnectDelayMs(this.#reconnectAttempt)
    this.#reconnectAttempt += 1

    let fiber: Fiber.Fiber<void, never>
    fiber = this.#runtime.runFork(
      Effect.sleep(delay).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (!this.#autoReconnectEnabled) return
            this.#openSocket(true)
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (this.#reconnectFiber === fiber) {
              this.#reconnectFiber = undefined
            }
          }),
        ),
      ),
    )
    this.#reconnectFiber = fiber
  }

  #forceReconnect() {
    if (!this.#autoReconnectEnabled || !this.#wsUrl || !this.#token) return
    if (this.#state === 'connected' || this.#state === 'connecting') return

    this.#reconnectAttempt = 0
    this.#clearReconnectTimer()
    this.#openSocket(true)
  }

  #closeSocket() {
    this.#cancelMigration()
    this.#stopHeartbeat()
    if (this.#ws) {
      this.#ws.onopen = null
      this.#ws.onmessage = null
      this.#ws.onerror = null
      this.#ws.onclose = null
      this.#ws.close()
      this.#ws = undefined
    }
  }

  #clearReconnectTimer() {
    const fiber = this.#reconnectFiber
    this.#reconnectFiber = undefined
    if (fiber) this.#runtime.runFork(Fiber.interrupt(fiber))
  }

  #touchActivity() {
    this.#lastMessageAt = Date.now()
    this.#resetHeartbeatTimeout()
  }

  #startHeartbeat() {
    this.#stopHeartbeat()
    const heartbeat = Effect.sync(() => {
      if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return
      this.send({ type: 'Ping', data: Date.now() })
      this.#resetHeartbeatTimeout()
    }).pipe(
      Effect.repeat(Schedule.spaced(HEARTBEAT_INTERVAL_MS)),
      Effect.delay(HEARTBEAT_INTERVAL_MS),
      Effect.asVoid,
    )
    this.#heartbeatFiber = this.#runtime.runFork(heartbeat)
    this.#resetHeartbeatTimeout()
  }

  #resetHeartbeatTimeout() {
    const previous = this.#heartbeatTimeoutFiber
    this.#heartbeatTimeoutFiber = undefined
    if (previous) this.#runtime.runFork(Fiber.interrupt(previous))

    let fiber: Fiber.Fiber<void, never>
    fiber = this.#runtime.runFork(
      Effect.sleep(HEARTBEAT_TIMEOUT_MS).pipe(
        Effect.andThen(
          Effect.sync(() => {
            const elapsed = Date.now() - this.#lastMessageAt
            if (elapsed < HEARTBEAT_TIMEOUT_MS) {
              this.#resetHeartbeatTimeout()
              return
            }
            if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
              this.#ws.close()
            }
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (this.#heartbeatTimeoutFiber === fiber) {
              this.#heartbeatTimeoutFiber = undefined
            }
          }),
        ),
      ),
    )
    this.#heartbeatTimeoutFiber = fiber
  }

  #stopHeartbeat() {
    const heartbeat = this.#heartbeatFiber
    this.#heartbeatFiber = undefined
    if (heartbeat) this.#runtime.runFork(Fiber.interrupt(heartbeat))

    const timeout = this.#heartbeatTimeoutFiber
    this.#heartbeatTimeoutFiber = undefined
    if (timeout) this.#runtime.runFork(Fiber.interrupt(timeout))
  }

  #sendOpen(event: Record<string, unknown>) {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return false
    try {
      this.#ws.send(JSON.stringify(event))
      return true
    } catch {
      return false
    }
  }

  #sendConnected(event: Record<string, unknown>) {
    if (this.#state !== 'connected') return false
    return this.#sendOpen(event)
  }

  #queueReliable(event: Record<string, unknown>, key?: string) {
    if (key) {
      const existingIndex = this.#reliableQueue.findIndex(
        (item) => item.key === key,
      )
      if (existingIndex >= 0) {
        this.#reliableQueue[existingIndex] = { event, key }
        return
      }
    }

    this.#reliableQueue.push({ event, key })
    if (this.#reliableQueue.length > RELIABLE_QUEUE_MAX) {
      this.#reliableQueue.shift()
    }
  }

  #flushReliableQueue() {
    if (this.#reliableQueue.length === 0) return

    const pending = this.#reliableQueue
    this.#reliableQueue = []

    for (let index = 0; index < pending.length; index += 1) {
      const item = pending[index]
      if (this.#sendConnected(item.event)) continue

      this.#reliableQueue = pending.slice(index)
      return
    }
  }

  #installLifecycleListeners() {
    this.#stopWatchingWake ??= this.#environment.watchWake(() => {
      this.#forceReconnect()
    })
  }

  #removeLifecycleListeners() {
    this.#stopWatchingWake?.()
    this.#stopWatchingWake = undefined
  }

  #setState(state: GatewayState) {
    if (this.#state === state) return
    this.#state = state
    this.#stateListeners.forEach((listener) => listener(state))
  }
}
