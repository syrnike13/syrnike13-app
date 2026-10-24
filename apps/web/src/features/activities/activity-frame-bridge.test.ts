// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_TAG, PROTOCOL_VERSION } from '@syrnike13/activity-sdk/protocol'

import {
  ActivityFrameBridge,
  ActivityFrameError,
  decodeRequestEnvelope,
  MAX_ENVELOPE_BYTES,
  type ActivityFrameHandlers,
} from './activity-frame-bridge'

const ORIGIN = 'https://chess.activities.syrnike13.ru'
const HELLO = { tag: PROTOCOL_TAG, v: PROTOCOL_VERSION, type: 'hello' }

function handlers(
  overrides: Partial<ActivityFrameHandlers> = {},
): ActivityFrameHandlers {
  const unexpected = () => Promise.reject(new ActivityFrameError('unsupported'))
  return {
    ready: unexpected,
    send: unexpected,
    setState: unexpected,
    getPlayerData: unexpected,
    setPlayerData: unexpected,
    submitScore: unexpected,
    getLeaderboard: unexpected,
    authorize: unexpected,
    openExternalLink: unexpected,
    leave: unexpected,
    end: unexpected,
    ...overrides,
  } as ActivityFrameHandlers
}

function nextMessage(port: MessagePort) {
  return new Promise<unknown>((resolve) => {
    port.onmessage = (event) => resolve(event.data)
  })
}

describe('ActivityFrameBridge', () => {
  let iframe: HTMLIFrameElement
  let frameWindow: Window
  let postMessage: ReturnType<typeof vi.fn>
  let bridge: ActivityFrameBridge | null

  beforeEach(() => {
    iframe = document.createElement('iframe')
    document.body.append(iframe)
    frameWindow = iframe.contentWindow!
    postMessage = vi.fn()
    frameWindow.postMessage = postMessage as typeof frameWindow.postMessage
    bridge = null
  })

  afterEach(() => {
    bridge?.dispose()
    iframe.remove()
  })

  function create(bridgeHandlers = handlers(), onConnect?: () => void) {
    bridge = new ActivityFrameBridge({
      iframe,
      origin: ORIGIN,
      handlers: bridgeHandlers,
      onConnect,
    })
    return bridge
  }

  function hello(source: Window | null = frameWindow, origin = ORIGIN) {
    window.dispatchEvent(
      new MessageEvent('message', { data: HELLO, origin, source }),
    )
  }

  function connectedPort() {
    hello()
    const [, , transfer] = postMessage.mock.calls.at(-1)!
    return (transfer as MessagePort[])[0]!
  }

  it('answers hello only from the iframe window and the Activity Origin', () => {
    const onConnect = vi.fn()
    create(handlers(), onConnect)

    hello(window)
    hello(frameWindow, 'https://evil.example')
    hello(frameWindow, 'https://other.activities.syrnike13.ru')
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { ...HELLO, v: 99 },
        origin: ORIGIN,
        source: frameWindow,
      }),
    )
    expect(postMessage).not.toHaveBeenCalled()

    hello()
    expect(postMessage).toHaveBeenCalledTimes(1)
    const [message, targetOrigin, transfer] = postMessage.mock.calls[0]!
    expect(message).toEqual({
      tag: PROTOCOL_TAG,
      v: PROTOCOL_VERSION,
      type: 'connect',
    })
    expect(targetOrigin).toBe(ORIGIN)
    expect(transfer).toHaveLength(1)
    expect(onConnect).toHaveBeenCalledTimes(1)
  })

  it('bridges requests and reports handler errors with codes', async () => {
    const send = vi.fn(() => Promise.resolve())
    const setState = vi.fn(() =>
      Promise.reject(new ActivityFrameError('payload_too_large')),
    )
    create(handlers({ send, setState }))
    const port = connectedPort()

    let response = nextMessage(port)
    port.postMessage({
      kind: 'request',
      id: 1,
      method: 'send',
      params: { payload: { move: 'e4' }, to: ['bob'] },
    })
    await expect(response).resolves.toEqual({
      kind: 'response',
      id: 1,
      result: undefined,
    })
    expect(send).toHaveBeenCalledWith({ payload: { move: 'e4' }, to: ['bob'] })

    response = nextMessage(port)
    port.postMessage({
      kind: 'request',
      id: 2,
      method: 'setState',
      params: { expectedVersion: 0, data: {} },
    })
    await expect(response).resolves.toEqual({
      kind: 'response',
      id: 2,
      error: { code: 'payload_too_large', message: 'payload_too_large' },
    })
    port.close()
  })

  it('rejects unknown methods and malformed params without calling handlers', async () => {
    const submitScore = vi.fn()
    create(handlers({ submitScore }))
    const port = connectedPort()

    let response = nextMessage(port)
    port.postMessage({ kind: 'request', id: 3, method: 'toString', params: {} })
    await expect(response).resolves.toMatchObject({
      id: 3,
      error: { code: 'invalid_request' },
    })

    response = nextMessage(port)
    port.postMessage({
      kind: 'request',
      id: 4,
      method: 'submitScore',
      params: { key: 'Bad Key', value: 1, mode: 'max' },
    })
    await expect(response).resolves.toMatchObject({
      id: 4,
      error: { code: 'invalid_request' },
    })
    expect(submitScore).not.toHaveBeenCalled()
    port.close()
  })

  it('replaces the port on a new hello and pushes events to the latest one', async () => {
    create()
    const first = connectedPort()
    const second = connectedPort()
    expect(first).not.toBe(second)

    const event = nextMessage(second)
    bridge!.emit('layout', { layout: 'focus' })
    await expect(event).resolves.toEqual({
      kind: 'event',
      event: 'layout',
      data: { layout: 'focus' },
    })
    first.close()
    second.close()
  })
})

describe('decodeRequestEnvelope', () => {
  it('ignores non-requests and flags oversized envelopes', () => {
    expect(decodeRequestEnvelope(null)).toBeNull()
    expect(decodeRequestEnvelope({ kind: 'event', id: 1 })).toBeNull()
    expect(decodeRequestEnvelope({ kind: 'request', id: -1 })).toBeNull()
    expect(
      decodeRequestEnvelope({
        kind: 'request',
        id: 1,
        method: 'send',
        params: { payload: 'x'.repeat(MAX_ENVELOPE_BYTES) },
      }),
    ).toEqual({ kind: 'invalid', id: 1 })
    expect(
      decodeRequestEnvelope({ kind: 'request', id: 5, method: 'ready' }),
    ).toEqual({ kind: 'request', id: 5, method: 'ready', params: undefined })
  })
})
