export type GatewayState = 'idle' | 'connecting' | 'connected' | 'disconnected'

type GatewayEvent = {
  type: string
  [key: string]: unknown
}

type StateListener = (state: GatewayState) => void
type EventListener = (event: GatewayEvent) => void

/**
 * Минимальный WebSocket-клиент syrnike13 (протокол v1, JSON).
 * Полноценный state sync — следующий этап.
 */
export class EventsGateway {
  #ws: WebSocket | undefined
  #state: GatewayState = 'idle'
  #stateListeners = new Set<StateListener>()
  #eventListeners = new Set<EventListener>()

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

  connect(wsUrl: string, token: string) {
    this.disconnect()
    this.#setState('connecting')

    const url = new URL(wsUrl)
    url.searchParams.set('version', '1')
    url.searchParams.set('format', 'json')
    url.searchParams.set('token', token)
    for (const field of [
      'users',
      'servers',
      'channels',
      'members',
      'emojis',
      'voice_states',
      'channel_unreads',
    ] as const) {
      url.searchParams.append('ready', field)
    }

    const ws = new WebSocket(url)
    this.#ws = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'Ping', data: Date.now() }))
    }

    ws.onmessage = (message) => {
      if (typeof message.data !== 'string') return

      try {
        const event = JSON.parse(message.data) as GatewayEvent

        if (event.type === 'Ping') {
          this.send({ type: 'Pong', data: event.data })
          return
        }

        if (event.type === 'Pong') {
          return
        }

        this.#eventListeners.forEach((listener) => listener(event))

        if (event.type === 'Error') {
          this.#setState('disconnected')
          return
        }

        if (event.type === 'Ready') {
          this.#setState('connected')
        }
      } catch {
        // ignore malformed frames
      }
    }

    ws.onerror = () => {
      this.#setState('disconnected')
    }

    ws.onclose = () => {
      this.#ws = undefined
      this.#setState('disconnected')
    }
  }

  send(event: Record<string, unknown>) {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return
    this.#ws.send(JSON.stringify(event))
  }

  beginTyping(channelId: string) {
    this.send({ type: 'BeginTyping', channel: channelId })
  }

  endTyping(channelId: string) {
    this.send({ type: 'EndTyping', channel: channelId })
  }

  disconnect() {
    if (this.#ws) {
      this.#ws.close()
      this.#ws = undefined
    }
    this.#setState('idle')
  }

  #setState(state: GatewayState) {
    this.#state = state
    this.#stateListeners.forEach((listener) => listener(state))
  }
}

export const eventsGateway = new EventsGateway()
