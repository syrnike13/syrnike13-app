// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EventsGateway } from './gateway'

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
    static OPEN = OPEN
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
    gateway = new EventsGateway()
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

  it('sends the latest activity update per source reliably after Ready', async () => {
    gateway.activity({
      activitySourceId: 'desktop:music',
      type: 'listening',
      name: 'Spotify',
      details: 'Old',
      observedAt: 1,
    })
    gateway.activity({
      activitySourceId: 'desktop:music',
      type: 'listening',
      name: 'Spotify',
      details: 'PRAXX',
      observedAt: 2,
    })
    gateway.activity({
      activitySourceId: 'desktop:game',
      type: 'playing',
      name: 'Counter-Strike 2',
      observedAt: 3,
    })

    gateway.connect('wss://example.test/ws', 'token-1')
    const socket = mock.sockets.at(-1)!

    await Promise.resolve()
    socket.send.mockClear()

    socket.onmessage?.({
      data: JSON.stringify({ type: 'Ready', users: [] }),
    })

    expect(socket.send).toHaveBeenCalledTimes(2)
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'UserActivityUpdate',
        activity: {
          activitySourceId: 'desktop:music',
          type: 'listening',
          name: 'Spotify',
          details: 'PRAXX',
          observedAt: 2,
        },
      }),
    )
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'UserActivityUpdate',
        activity: {
          activitySourceId: 'desktop:game',
          type: 'playing',
          name: 'Counter-Strike 2',
          observedAt: 3,
        },
      }),
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
