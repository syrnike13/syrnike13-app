import type { VoiceGatewayTransport } from '@syrnike13/platform'

import { WS_URL } from '../config'

type GatewayEvent = Record<string, unknown> & { type?: unknown }
type GatewayState = 'connected' | 'unavailable'

const READY_FIELDS = ['servers', 'channels', 'voice_states'] as const
const HEARTBEAT_INTERVAL_MS = 30_000
const RECONNECT_DELAY_MS = 2_000

/**
 * Minimal gateway client for the voice prototype: one socket, heartbeat and a
 * fixed reconnect delay. Reliable messages wait in a keyed queue while offline.
 */
export class Gateway implements VoiceGatewayTransport {
  private socket: WebSocket | null = null
  private state: GatewayState = 'unavailable'
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private reconnect: ReturnType<typeof setTimeout> | null = null
  private closed = false
  private readonly queue = new Map<string, unknown>()
  private readonly eventListeners = new Set<(event: GatewayEvent) => void>()
  private readonly stateListeners = new Set<(state: GatewayState) => void>()

  constructor(private readonly token: string) {
    this.open()
  }

  sendReliable(message: Record<string, unknown>, key: string) {
    if (this.state === 'connected') this.socket?.send(JSON.stringify(message))
    else this.queue.set(key, message)
  }

  subscribeEvents(listener: (event: GatewayEvent) => void) {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  subscribeState(listener: (state: GatewayState) => void) {
    this.stateListeners.add(listener)
    listener(this.state)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  close() {
    this.closed = true
    if (this.reconnect) clearTimeout(this.reconnect)
    this.socket?.close()
  }

  private open() {
    const params = new URLSearchParams({
      version: '1',
      format: 'json',
      token: this.token,
      client: 'mobile',
    })
    for (const field of READY_FIELDS) params.append('ready', field)

    const socket = new WebSocket(`${WS_URL}?${params}`)
    this.socket = socket
    socket.onmessage = (message) => {
      const event = JSON.parse(String(message.data)) as GatewayEvent
      if (event.type === 'Ping') {
        socket.send(JSON.stringify({ type: 'Pong', data: event.data }))
        return
      }
      if (event.type === 'Ready') this.setState('connected')
      for (const listener of this.eventListeners) listener(event)
    }
    socket.onopen = () => {
      this.heartbeat = setInterval(
        () => socket.send(JSON.stringify({ type: 'Ping', data: Date.now() })),
        HEARTBEAT_INTERVAL_MS,
      )
    }
    socket.onclose = () => {
      if (this.heartbeat) clearInterval(this.heartbeat)
      this.setState('unavailable')
      if (!this.closed) {
        this.reconnect = setTimeout(() => this.open(), RECONNECT_DELAY_MS)
      }
    }
  }

  private setState(state: GatewayState) {
    if (this.state === state) return
    this.state = state
    if (state === 'connected') {
      for (const message of this.queue.values()) {
        this.socket?.send(JSON.stringify(message))
      }
      this.queue.clear()
    }
    for (const listener of this.stateListeners) listener(state)
  }
}
