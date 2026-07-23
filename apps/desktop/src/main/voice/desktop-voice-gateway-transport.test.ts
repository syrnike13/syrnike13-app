import { afterEach, describe, expect, it, vi } from 'vitest'

import { DesktopVoiceGatewayTransport } from './desktop-voice-gateway-transport'

class FakeSocket {
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  readonly sent: string[] = []

  open() {
    this.readyState = 1
    this.onopen?.()
  }

  event(value: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(value) })
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = 3
  }

  unexpectedClose() {
    this.readyState = 3
    this.onclose?.()
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('DesktopVoiceGatewayTransport', () => {
  it('queues authority commands until authenticated Ready', () => {
    const sockets: FakeSocket[] = []
    const transport = new DesktopVoiceGatewayTransport({
      createSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
    })
    transport.configure('wss://example.invalid/ws', 'session-token')
    transport.sendReliable(
      {
        type: 'VoiceStateUpdate',
        nonce: 'nonce-a',
        request: { mode: 'request_snapshot' },
      },
      'snapshot',
    )
    expect(sockets[0].sent).toHaveLength(0)

    sockets[0].open()
    sockets[0].event({ type: 'Ready' })

    expect(sockets[0].sent.map((item) => JSON.parse(item))).toContainEqual({
      type: 'VoiceStateUpdate',
      nonce: 'nonce-a',
      request: { mode: 'request_snapshot' },
    })
    transport.stop()
  })

  it('does not replay an acknowledged mutation after control reconnect', () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    const transport = new DesktopVoiceGatewayTransport({
      createSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
    })
    transport.configure('wss://example.invalid/ws', 'session-token')
    sockets[0].open()
    sockets[0].event({ type: 'Ready' })
    transport.sendReliable(
      {
        type: 'VoiceStateUpdate',
        nonce: 'nonce-a',
        request: { mode: 'disconnect', operation_id: 'voice-op-a' },
      },
      'release',
    )
    sockets[0].event({ type: 'VoiceStateAck', nonce: 'nonce-a', ok: true })

    sockets[0].unexpectedClose()
    vi.advanceTimersByTime(250)
    sockets[1].open()
    sockets[1].event({ type: 'Ready' })

    expect(
      sockets[1].sent.some((item) => item.includes('voice-op-a')),
    ).toBe(false)
    transport.stop()
  })

  it('reconnects a silent control socket without tearing down RTC itself', () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    const states: string[] = []
    const transport = new DesktopVoiceGatewayTransport({
      createSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
    })
    transport.subscribeState((state) => states.push(state))
    transport.configure('wss://example.invalid/ws', 'session-token')
    sockets[0].open()
    sockets[0].event({ type: 'Ready' })

    vi.advanceTimersByTime(30_000)
    vi.advanceTimersByTime(10_000)
    expect(sockets[0].readyState).toBe(3)
    expect(states.at(-1)).toBe('unavailable')

    vi.advanceTimersByTime(250)
    expect(sockets).toHaveLength(2)
    transport.stop()
  })

  it('records safe server error fields in control diagnostics', () => {
    const diagnostics = vi.fn()
    const socket = new FakeSocket()
    const transport = new DesktopVoiceGatewayTransport({
      createSocket: () => socket,
      diagnostics,
    })
    transport.configure('wss://example.invalid/ws', 'session-token')
    socket.open()
    socket.event({
      type: 'Error',
      fatal: true,
      scope: 'Session',
      data: {
        type: 'InvalidSession',
        message: 'Session token is invalid.',
        secret: 'must-not-be-logged',
      },
    })

    expect(diagnostics).toHaveBeenCalledWith(
      'control_event',
      expect.objectContaining({
        eventType: 'Error',
        fatal: true,
        errorScope: 'Session',
        errorType: 'InvalidSession',
        errorMessage: 'Session token is invalid.',
      }),
    )
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain(
      'must-not-be-logged',
    )
    transport.stop()
  })

  it('treats an Error without an explicit disposition as fatal', () => {
    const diagnostics = vi.fn()
    const socket = new FakeSocket()
    const transport = new DesktopVoiceGatewayTransport({
      createSocket: () => socket,
      diagnostics,
    })
    transport.configure('wss://example.invalid/ws', 'session-token')
    socket.open()
    socket.event({
      type: 'Error',
      scope: 'Session',
      data: {
        type: 'InvalidOperation',
        message: 'Malformed gateway error.',
      },
    })

    expect(diagnostics).toHaveBeenCalledWith(
      'control_event',
      expect.objectContaining({
        eventType: 'Error',
        fatal: true,
        errorType: 'InvalidOperation',
      }),
    )
    transport.stop()
  })
})
