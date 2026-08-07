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
  'channel_unreads',
  'authorization',
] as const

const HEARTBEAT_INTERVAL_MS = 30_000
const HEARTBEAT_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * 2
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const RELIABLE_QUEUE_MAX = 64

function gatewayClientKind() {
  return window.syrnikeDesktop?.runtime === 'desktop' ? 'desktop' : 'web'
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
  #onVisibilityChange: (() => void) | undefined
  #onNetworkOnline: (() => void) | undefined
  #reliableQueue: ReliableQueueItem[] = []

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

  #openSocket(isReconnect: boolean) {
    const wsUrl = this.#wsUrl
    const token = this.#token
    if (!wsUrl || !token) return

    this.#closeSocket()
    this.#manualClose = false
    this.#setState(isReconnect ? 'reconnecting' : 'connecting')

    const url = new URL(wsUrl)
    url.searchParams.set('version', '1')
    url.searchParams.set('format', 'json')
    url.searchParams.set('token', token)
    url.searchParams.set('client', gatewayClientKind())
    for (const field of READY_FIELDS) {
      url.searchParams.append('ready', field)
    }

    const ws = new WebSocket(url)
    this.#ws = ws

    ws.onopen = () => {
      this.#touchActivity()
      this.#startHeartbeat()
      ws.send(JSON.stringify({ type: 'Ping', data: Date.now() }))
    }

    ws.onmessage = (message) => {
      if (typeof message.data !== 'string') return
      this.#touchActivity()

      const decoded = Schema.decodeUnknownOption(GatewayJsonEventSchema)(
        message.data,
      )
      if (Option.isSome(decoded)) {
        const event = decoded.value

        if (event.type === 'Ping') {
          this.send({ type: 'Pong', data: event.data })
          return
        }

        if (event.type === 'Pong') {
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
    }

    ws.onerror = () => {
      if (this.#state !== 'connected') {
        this.#setState('disconnected')
      }
    }

    ws.onclose = () => {
      this.#ws = undefined
      this.#stopHeartbeat()
      this.#handleUnexpectedClose()
    }
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

    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.#reconnectAttempt,
      RECONNECT_MAX_MS,
    )
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
    if (typeof window === 'undefined') return
    if (this.#onVisibilityChange) return

    this.#onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      this.#forceReconnect()
    }
    this.#onNetworkOnline = () => {
      this.#forceReconnect()
    }

    document.addEventListener('visibilitychange', this.#onVisibilityChange)
    window.addEventListener('online', this.#onNetworkOnline)
  }

  #removeLifecycleListeners() {
    if (typeof window === 'undefined') return
    if (this.#onVisibilityChange) {
      document.removeEventListener('visibilitychange', this.#onVisibilityChange)
      this.#onVisibilityChange = undefined
    }
    if (this.#onNetworkOnline) {
      window.removeEventListener('online', this.#onNetworkOnline)
      this.#onNetworkOnline = undefined
    }
  }

  #setState(state: GatewayState) {
    if (this.#state === state) return
    this.#state = state
    this.#stateListeners.forEach((listener) => listener(state))
  }
}

export const eventsGateway = new EventsGateway()
