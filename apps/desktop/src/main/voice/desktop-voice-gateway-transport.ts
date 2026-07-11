import type {
  VoiceGatewayTransport,
  VoiceGatewayTransportState,
} from '@syrnike13/platform'

const HEARTBEAT_MS = 30_000
const HEARTBEAT_TIMEOUT_MS = 10_000
const RECONNECT_DELAYS_MS = [250, 1_000, 5_000]

type SocketLike = {
  readonly readyState: number
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
  send(data: string): void
  close(): void
}

type PendingReliableMessage = {
  message: Record<string, unknown>
  nonce?: string
}

export type DesktopVoiceGatewayTransportOptions = Readonly<{
  createSocket?: (url: string) => SocketLike
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
  diagnostics?: (event: string, data?: unknown) => void
}>

/** Dedicated authenticated control socket owned by Electron main. */
export class DesktopVoiceGatewayTransport implements VoiceGatewayTransport {
  private readonly eventListeners = new Set<
    (event: Record<string, unknown>) => void
  >()
  private readonly stateListeners = new Set<
    (state: VoiceGatewayTransportState) => void
  >()
  private readonly reliable = new Map<string, PendingReliableMessage>()
  private readonly createSocket: (url: string) => SocketLike
  private readonly setTimer: typeof setTimeout
  private readonly clearTimer: typeof clearTimeout
  private readonly diagnostics: NonNullable<
    DesktopVoiceGatewayTransportOptions['diagnostics']
  >
  private socket: SocketLike | null = null
  private wsUrl: string | null = null
  private token: string | null = null
  private state: VoiceGatewayTransportState = 'unavailable'
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = true

  constructor(options: DesktopVoiceGatewayTransportOptions = {}) {
    this.createSocket =
      options.createSocket ??
      ((url) => new WebSocket(url) as unknown as SocketLike)
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
    this.diagnostics = options.diagnostics ?? (() => undefined)
  }

  configure(wsUrl: string, token: string) {
    if (!wsUrl || !token) throw new Error('Voice control credentials are required')
    const unchanged = this.wsUrl === wsUrl && this.token === token && !this.stopped
    this.wsUrl = wsUrl
    this.token = token
    this.stopped = false
    this.log('control_configured', { credentialsChanged: !unchanged })
    if (unchanged && this.socket) return
    this.reconnectAttempt = 0
    this.closeSocket()
    this.openSocket()
  }

  stop() {
    this.log('control_stopped')
    this.stopped = true
    this.wsUrl = null
    this.token = null
    this.reliable.clear()
    this.clearReconnect()
    this.stopHeartbeat()
    this.closeSocket()
    this.setState('unavailable')
  }

  sendReliable(message: Record<string, unknown>, key: string) {
    const nonce = typeof message.nonce === 'string' ? message.nonce : undefined
    this.reliable.set(key, { message, nonce })
    this.log('control_reliable_queued', {
      messageType: typeof message.type === 'string' ? message.type : 'unknown',
      pendingCount: this.reliable.size,
    })
    this.sendWhenReady(message)
  }

  subscribeEvents(listener: (event: Record<string, unknown>) => void) {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  subscribeState(listener: (state: VoiceGatewayTransportState) => void) {
    this.stateListeners.add(listener)
    listener(this.state)
    return () => this.stateListeners.delete(listener)
  }

  private openSocket() {
    if (this.stopped || !this.wsUrl || !this.token) return
    this.clearReconnect()
    const url = new URL(this.wsUrl)
    url.searchParams.set('version', '1')
    url.searchParams.set('format', 'json')
    url.searchParams.set('token', this.token)
    url.searchParams.set('client', 'desktop')
    // An explicit empty selection avoids duplicating the renderer's large
    // Ready payload while still receiving the authenticated Ready boundary.
    url.searchParams.append('ready', 'voice_states')

    const socket = this.createSocket(url.toString())
    this.log('control_socket_created', {
      reconnectAttempt: this.reconnectAttempt,
    })
    this.socket = socket
    socket.onopen = () => {
      if (this.socket !== socket) return
      this.log('control_socket_open')
      this.sendHeartbeat(socket)
      this.scheduleHeartbeat(socket)
    }
    socket.onmessage = (message) => this.handleMessage(socket, message.data)
    socket.onerror = () => this.handleSocketLoss(socket, 'control_socket_error')
    socket.onclose = () => this.handleSocketLoss(socket, 'control_socket_closed')
  }

  private handleMessage(socket: SocketLike, raw: unknown) {
    if (this.socket !== socket || typeof raw !== 'string') return
    let event: Record<string, unknown>
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!isRecord(parsed)) return
      event = parsed
    } catch {
      return
    }
    this.acknowledgeHeartbeat()
    if (event.type === 'Ping') {
      socket.send(JSON.stringify({ type: 'Pong', data: event.data }))
      return
    }
    if (event.type === 'Pong') return

    this.log('control_event', {
      eventType: typeof event.type === 'string' ? event.type : 'unknown',
    })

    this.acknowledgeReliable(event)
    for (const listener of this.eventListeners) listener(event)
    if (event.type === 'Ready') {
      this.reconnectAttempt = 0
      this.setState('connected')
      this.log('control_ready', { pendingCount: this.reliable.size })
      for (const pending of this.reliable.values()) {
        this.sendWhenReady(pending.message)
      }
    }
  }

  private acknowledgeReliable(event: Record<string, unknown>) {
    if (event.type === 'VoiceStateAck' && typeof event.nonce === 'string') {
      for (const [key, pending] of this.reliable) {
        if (pending.nonce === event.nonce) this.reliable.delete(key)
      }
      return
    }
    if (event.type === 'VoiceServerUpdate' || event.type === 'Error') {
      const errorRequest = isRecord(event.request) ? event.request : null
      const operationId =
        typeof event.operation_id === 'string'
          ? event.operation_id
          : typeof errorRequest?.operation_id === 'string'
            ? errorRequest.operation_id
            : null
      if (!operationId) return
      for (const [key, pending] of this.reliable) {
        const request = isRecord(pending.message.request)
          ? pending.message.request
          : null
        if (request?.operation_id === operationId) this.reliable.delete(key)
      }
    }
  }

  private sendWhenReady(message: Record<string, unknown>) {
    if (this.state !== 'connected' || !this.socket || this.socket.readyState !== 1) {
      return
    }
    this.socket.send(JSON.stringify(message))
  }

  private scheduleHeartbeat(socket: SocketLike) {
    if (this.heartbeatTimer) {
      this.clearTimer(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.heartbeatTimer = this.setTimer(() => {
      this.heartbeatTimer = null
      if (this.socket !== socket || socket.readyState !== 1) return
      this.sendHeartbeat(socket)
      this.scheduleHeartbeat(socket)
    }, HEARTBEAT_MS)
  }

  private sendHeartbeat(socket: SocketLike) {
    socket.send(JSON.stringify({ type: 'Ping', data: Date.now() }))
    this.acknowledgeHeartbeat()
    this.heartbeatTimeoutTimer = this.setTimer(() => {
      this.heartbeatTimeoutTimer = null
      this.handleSocketLoss(socket, 'control_heartbeat_timeout')
    }, HEARTBEAT_TIMEOUT_MS)
  }

  private acknowledgeHeartbeat() {
    if (!this.heartbeatTimeoutTimer) return
    this.clearTimer(this.heartbeatTimeoutTimer)
    this.heartbeatTimeoutTimer = null
  }

  private handleSocketLoss(socket: SocketLike, event: string) {
    if (this.socket !== socket) return
    this.socket = null
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
    socket.close()
    this.log(event)
    this.stopHeartbeat()
    this.setState('unavailable')
    this.scheduleReconnect()
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return
    const delay =
      RECONNECT_DELAYS_MS[
        Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
      ]
    this.reconnectAttempt += 1
    this.log('control_reconnect_scheduled', {
      delayMs: delay,
      reconnectAttempt: this.reconnectAttempt,
    })
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null
      this.openSocket()
    }, delay)
  }

  private clearReconnect() {
    if (!this.reconnectTimer) return
    this.clearTimer(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      this.clearTimer(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.acknowledgeHeartbeat()
  }

  private closeSocket() {
    this.stopHeartbeat()
    const socket = this.socket
    this.socket = null
    if (!socket) return
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
    socket.close()
  }

  private setState(state: VoiceGatewayTransportState) {
    if (this.state === state) return
    this.state = state
    this.log('control_state_changed', { state })
    for (const listener of this.stateListeners) listener(state)
  }

  private log(event: string, data?: unknown) {
    try {
      this.diagnostics(event, data)
    } catch {
      // Diagnostics must not affect the authenticated control transport.
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
