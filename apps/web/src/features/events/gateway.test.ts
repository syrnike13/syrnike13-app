// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  EventsGateway,
  gatewayReconnectDelayMs,
} from '@syrnike13/client/gateway/events-gateway'

import { webGatewayEnvironment } from './gateway'

type MockSocket = {
  url: string
  readyState: number
  onopen: (() => void) | null
  onmessage: ((event: { data: string }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
  send: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

const OPEN = 1

function createMockWebSocket() {
  const sockets: MockSocket[] = []

  class MockWebSocket {
    static CONNECTING = 0
    static OPEN = OPEN
    static CLOSING = 2
    static CLOSED = 3
    url: string
    readyState = OPEN
    onopen: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onerror: (() => void) | null = null
    onclose: (() => void) | null = null
    send = vi.fn()
    close = vi.fn(() => {
      this.readyState = 3
      this.onclose?.()
    })

    constructor(url: string | URL) {
      this.url = String(url)
      sockets.push(this as unknown as MockSocket)
      queueMicrotask(() => this.onopen?.())
    }
  }

  vi.stubGlobal('WebSocket', MockWebSocket)

  return {
    sockets,
    restore: () => vi.unstubAllGlobals(),
  }
}

describe('EventsGateway', () => {
  let mock: ReturnType<typeof createMockWebSocket>
  let gateway: EventsGateway

  beforeEach(() => {
    vi.useFakeTimers()
    mock = createMockWebSocket()
    gateway = new EventsGateway(webGatewayEnvironment)
  })

  afterEach(() => {
    gateway.disconnect()
    window.syrnikeDesktop = undefined
    mock.restore()
    vi.useRealTimers()
  })

  it('connects and becomes connected on Ready', () => {
    const states: string[] = []
    gateway.subscribeState((state) => states.push(state))

    gateway.connect('wss://example.test/ws', 'token-1')
    expect(states).toContain('connecting')

    const socket = mock.sockets.at(-1)
    socket?.onmessage?.({
      data: JSON.stringify({ type: 'Ready', users: [] }),
    })

    expect(gateway.state).toBe('connected')
  })

  it('emits only schema-valid server events to typed subscribers', () => {
    const events: Array<{ type: string }> = []
    gateway.subscribeServerEvents((event) => events.push(event))
    gateway.connect('wss://example.test/ws', 'token-1')

    const socket = mock.sockets.at(-1)
    socket?.onmessage?.({
      data: JSON.stringify({
        type: 'UserPresence',
        id: 'user-1',
        online: 'yes',
      }),
    })
    socket?.onmessage?.({
      data: JSON.stringify({
        type: 'UserPresence',
        id: 'user-1',
        online: true,
      }),
    })

    expect(events).toEqual([
      { type: 'UserPresence', id: 'user-1', online: true },
    ])
  })

  it('validates nested gateway payloads and Bulk members', () => {
    const events: Array<{ type: string }> = []
    gateway.subscribeServerEvents((event) => events.push(event))
    gateway.connect('wss://example.test/ws', 'token-1')

    const socket = mock.sockets.at(-1)
    socket?.onmessage?.({
      data: JSON.stringify({
        type: 'Ready',
        users: [{ _id: 'user-1', username: 'alice' }],
      }),
    })
    socket?.onmessage?.({
      data: JSON.stringify({
        type: 'Bulk',
        v: [
          {
            type: 'UserPresence',
            id: 'user-1',
            online: true,
          },
        ],
      }),
    })

    expect(events).toEqual([
      {
        type: 'Bulk',
        v: [
          {
            type: 'UserPresence',
            id: 'user-1',
            online: true,
          },
        ],
      },
    ])
  })

  it('adds the web client kind to gateway URLs by default', () => {
    gateway.connect('wss://example.test/ws', 'token-1')

    const url = new URL(mock.sockets.at(-1)!.url)
    expect(url.searchParams.get('client')).toBe('web')
  })

  it('adds the desktop client kind when running inside Electron', () => {
    window.syrnikeDesktop = { runtime: 'desktop' } as never

    gateway.connect('wss://example.test/ws', 'token-1')

    const url = new URL(mock.sockets.at(-1)!.url)
    expect(url.searchParams.get('client')).toBe('desktop')
  })

  it('sends user activity only after Ready', async () => {
    gateway.connect('wss://example.test/ws', 'token-1')
    const socket = mock.sockets.at(-1)!

    await Promise.resolve()
    socket.send.mockClear()

    gateway.userActivity()
    expect(socket.send).not.toHaveBeenCalled()

    socket.onmessage?.({
      data: JSON.stringify({ type: 'Ready', users: [] }),
    })
    gateway.userActivity()

    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'UserActivity' }),
    )
  })

  it('does not notify state subscribers when state does not change', () => {
    const states: string[] = []
    gateway.subscribeState((state) => states.push(state))

    gateway.connect('wss://example.test/ws', 'token-1')
    gateway.connect('wss://example.test/ws', 'token-1')

    expect(states).toEqual(['idle', 'connecting'])
  })

  it('queues reliable events while disconnected and flushes the latest intent after Ready', async () => {
    gateway.sendReliable(
      { type: 'VoiceStateUpdate', channel_id: 'channel-1' },
      'voice-state',
    )
    gateway.sendReliable(
      { type: 'VoiceStateUpdate', channel_id: null },
      'voice-state',
    )

    gateway.connect('wss://example.test/ws', 'token-1')
    const socket = mock.sockets.at(-1)!

    await Promise.resolve()
    socket.send.mockClear()

    socket.onmessage?.({
      data: JSON.stringify({ type: 'Ready', users: [] }),
    })

    expect(socket.send).toHaveBeenCalledTimes(1)
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'VoiceStateUpdate', channel_id: null }),
    )
  })

  it('schedules reconnect after unexpected close when auto-reconnect is enabled', () => {
    gateway.enableAutoReconnect('wss://example.test/ws', 'token-1')
    gateway.connect('wss://example.test/ws', 'token-1')

    const socket = mock.sockets.at(-1)
    socket?.onmessage?.({
      data: JSON.stringify({ type: 'Ready', users: [] }),
    })
    expect(gateway.state).toBe('connected')

    socket?.onclose?.()
    expect(gateway.state).toBe('reconnecting')

    vi.advanceTimersByTime(1_000)
    expect(mock.sockets).toHaveLength(2)
  })

  it('keeps the socket connected when server sends recoverable request error', () => {
    gateway.enableAutoReconnect('wss://example.test/ws', 'token-1')
    gateway.connect('wss://example.test/ws', 'token-1')

    const socket = mock.sockets.at(-1)!
    socket.onmessage?.({
      data: JSON.stringify({ type: 'Ready', users: [] }),
    })
    expect(gateway.state).toBe('connected')

    socket.onmessage?.({
      data: JSON.stringify({
        type: 'Error',
        fatal: false,
        scope: 'VoiceStateUpdate',
        request: {
          kind: 'VoiceStateUpdate',
          operation_id: 'op-join',
          channel_id: 'channel-1',
        },
        data: { type: 'InvalidOperation' },
      }),
    })

    expect(socket.close).not.toHaveBeenCalled()
    expect(gateway.state).toBe('connected')

    vi.advanceTimersByTime(1_000)
    expect(mock.sockets).toHaveLength(1)
  })

  it('schedules reconnect once when server sends fatal Error then closes socket', () => {
    gateway.enableAutoReconnect('wss://example.test/ws', 'token-1')
    gateway.connect('wss://example.test/ws', 'token-1')

    const socket = mock.sockets.at(-1)!
    socket.onmessage?.({
      data: JSON.stringify({ type: 'Ready', users: [] }),
    })
    expect(gateway.state).toBe('connected')

    socket.onmessage?.({
      data: JSON.stringify({
        type: 'Error',
        fatal: true,
        scope: 'Session',
        data: { type: 'InvalidSession' },
      }),
    })
    expect(socket.close).toHaveBeenCalledTimes(1)
    expect(gateway.state).toBe('reconnecting')

    vi.advanceTimersByTime(1_000)
    expect(mock.sockets).toHaveLength(2)
  })

  it('treats Error without explicit fatal flag as fatal protocol violation', () => {
    gateway.enableAutoReconnect('wss://example.test/ws', 'token-1')
    gateway.connect('wss://example.test/ws', 'token-1')

    const socket = mock.sockets.at(-1)!
    socket.onmessage?.({
      data: JSON.stringify({ type: 'Ready', users: [] }),
    })
    expect(gateway.state).toBe('connected')

    socket.onmessage?.({
      data: JSON.stringify({ type: 'Error', data: { type: 'InvalidOperation' } }),
    })

    expect(socket.close).toHaveBeenCalledTimes(1)
    expect(gateway.state).toBe('reconnecting')
  })

  it('does not reconnect after manual disconnect', () => {
    gateway.enableAutoReconnect('wss://example.test/ws', 'token-1')
    gateway.connect('wss://example.test/ws', 'token-1')

    gateway.disconnect()
    expect(gateway.state).toBe('idle')

    vi.advanceTimersByTime(60_000)
    expect(mock.sockets).toHaveLength(1)
  })

  it('resets backoff after successful Ready on reconnect', () => {
    gateway.enableAutoReconnect('wss://example.test/ws', 'token-1')
    gateway.connect('wss://example.test/ws', 'token-1')

    mock.sockets.at(-1)?.onclose?.()
    vi.advanceTimersByTime(1_000)

    const reconnectSocket = mock.sockets.at(-1)
    reconnectSocket?.onmessage?.({
      data: JSON.stringify({ type: 'Ready', users: [] }),
    })
    expect(gateway.state).toBe('connected')

    reconnectSocket?.onclose?.()
    vi.advanceTimersByTime(1_000)
    expect(mock.sockets).toHaveLength(3)
  })

  it('reconnect() opens a new socket immediately', () => {
    gateway.enableAutoReconnect('wss://example.test/ws', 'token-1')
    gateway.connect('wss://example.test/ws', 'token-1')
    mock.sockets.at(-1)?.onclose?.()

    expect(gateway.state).toBe('reconnecting')

    gateway.reconnect()
    expect(mock.sockets).toHaveLength(2)
  })

  it('removes lifecycle listeners on disableAutoReconnect', () => {
    const removeVisibility = vi.spyOn(document, 'removeEventListener')
    const removeOnline = vi.spyOn(window, 'removeEventListener')

    gateway.enableAutoReconnect('wss://example.test/ws', 'token-1')
    gateway.disableAutoReconnect()

    expect(removeVisibility).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function),
    )
    expect(removeOnline).toHaveBeenCalledWith('online', expect.any(Function))
  })
})

describe('EventsGateway migration', () => {
  let mock: ReturnType<typeof createMockWebSocket>
  let gateway: EventsGateway
  let events: string[]
  let states: string[]

  const send = (socket: MockSocket | undefined, event: object) =>
    socket?.onmessage?.({ data: JSON.stringify(event) })

  beforeEach(() => {
    vi.useFakeTimers()
    mock = createMockWebSocket()
    gateway = new EventsGateway(webGatewayEnvironment)
    events = []
    states = []
    gateway.enableAutoReconnect('wss://example.test/ws', 'token-1')
    gateway.connect('wss://example.test/ws', 'token-1')
    send(mock.sockets[0], { type: 'Ready', users: [] })
    gateway.subscribeEvents((event) => events.push(String(event.type)))
    gateway.subscribeState((state) => states.push(state))
  })

  afterEach(() => {
    gateway.disconnect()
    mock.restore()
    vi.useRealTimers()
  })

  it('switches to a new connection once it is Ready without disconnecting', () => {
    const [old] = mock.sockets
    send(old, { type: 'Reconnect' })
    expect(mock.sockets).toHaveLength(2)
    const next = mock.sockets[1]

    send(old, { type: 'ChannelStartTyping', id: 'channel-1', user: 'user-1' })
    send(next, { type: 'Authenticated' })
    send(next, { type: 'Ready', users: [] })
    expect(old?.close).toHaveBeenCalled()
    // The old connection kept the state current, so the new Ready snapshot
    // must not replace it.
    expect(events).toEqual(['ChannelStartTyping'])

    // Events published while both connections were open arrive on both.
    send(next, { type: 'ChannelStartTyping', id: 'channel-1', user: 'user-1' })
    send(next, { type: 'ChannelStopTyping', id: 'channel-1', user: 'user-1' })
    expect(events).toEqual(['ChannelStartTyping', 'ChannelStopTyping'])
    expect(states).toEqual(['connected'])

    gateway.send({ type: 'BeginTyping', channel: 'channel-1' })
    expect(next?.send).toHaveBeenLastCalledWith(
      JSON.stringify({ type: 'BeginTyping', channel: 'channel-1' }),
    )
  })

  it('continues on the new connection when the old one closes first', () => {
    const [old] = mock.sockets
    send(old, { type: 'Reconnect' })
    const next = mock.sockets[1]

    old?.onclose?.()
    expect(gateway.state).toBe('reconnecting')
    expect(mock.sockets).toHaveLength(2)

    send(next, { type: 'Ready', users: [] })
    expect(gateway.state).toBe('connected')
    expect(events).toEqual(['Ready'])
  })

  it('reconnects normally when the old connection closes before the new one opens', () => {
    const [old] = mock.sockets
    send(old, { type: 'Reconnect' })
    const next = mock.sockets[1]
    if (next) next.readyState = 0

    old?.onclose?.()
    expect(next?.close).toHaveBeenCalled()
    expect(gateway.state).toBe('reconnecting')

    vi.advanceTimersByTime(1_000)
    expect(mock.sockets).toHaveLength(3)
  })

  it('does not skip events on a later ordinary reconnect', () => {
    const [old] = mock.sockets
    send(old, { type: 'Reconnect' })
    send(old, { type: 'ChannelStartTyping', id: 'channel-1', user: 'user-1' })
    const next = mock.sockets[1]
    send(next, { type: 'Ready', users: [] })

    next?.onclose?.()
    vi.advanceTimersByTime(1_000)
    const third = mock.sockets[2]
    send(third, { type: 'Ready', users: [] })
    send(third, { type: 'ChannelStartTyping', id: 'channel-1', user: 'user-1' })
    expect(events).toEqual(['ChannelStartTyping', 'Ready', 'ChannelStartTyping'])
  })

  it('keeps the old connection when the new one fails', () => {
    const [old] = mock.sockets
    send(old, { type: 'Reconnect' })
    mock.sockets[1]?.onclose?.()

    send(old, { type: 'ChannelStartTyping', id: 'channel-1', user: 'user-1' })
    expect(events).toEqual(['ChannelStartTyping'])
    expect(old?.close).not.toHaveBeenCalled()
    expect(gateway.state).toBe('connected')
  })
})

describe('gatewayReconnectDelayMs', () => {
  it('retries quickly during the first minute of an outage', () => {
    const max = Array.from({ length: 15 }, (_, attempt) =>
      gatewayReconnectDelayMs(attempt, () => 1),
    )
    expect(max.slice(0, 5)).toEqual([500, 1_000, 2_000, 4_000, 5_000])
    expect(Math.max(...max)).toBe(5_000)
  })

  it('backs off to the long cap after the fast attempts', () => {
    expect(gatewayReconnectDelayMs(15, () => 1)).toBe(30_000)
    expect(gatewayReconnectDelayMs(40, () => 1)).toBe(30_000)
  })

  it('jitters within the upper half of each step', () => {
    expect(gatewayReconnectDelayMs(0, () => 0)).toBe(250)
    expect(gatewayReconnectDelayMs(4, () => 0)).toBe(2_500)
    expect(gatewayReconnectDelayMs(20, () => 0)).toBe(15_000)
  })
})
