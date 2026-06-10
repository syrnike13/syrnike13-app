import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendReliable = vi.fn()
let eventHandler: ((event: { type: string; [key: string]: unknown }) => void) | null =
  null
let stateHandler: ((state: string) => void) | null = null

vi.mock('#/features/events/gateway', () => ({
  eventsGateway: {
    state: 'connected',
    sendReliable,
    subscribeEvents: vi.fn((handler) => {
      eventHandler = handler
      return vi.fn()
    }),
    subscribeState: vi.fn((handler) => {
      stateHandler = handler
      return vi.fn()
    }),
  },
}))

vi.mock('#/features/voice/voice-node', () => ({
  resolveVoiceNodeName: vi.fn(async () => 'node-1'),
}))

describe('voice gateway reliable state updates', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    vi.clearAllMocks()
    eventHandler = null
    stateHandler = null
  })

  it('sends voice state updates with a nonce and retries until ack', async () => {
    const { sendVoiceStateUpdate } = await import('./voice-gateway')

    sendVoiceStateUpdate({
      channel_id: 'channel-1',
      self_mute: false,
      self_deaf: false,
    })

    const firstEvent = sendReliable.mock.calls[0]?.[0]
    expect(firstEvent).toMatchObject({
      type: 'VoiceStateUpdate',
      channel_id: 'channel-1',
      self_mute: false,
      self_deaf: false,
      nonce: expect.any(String),
    })
    expect(sendReliable.mock.calls[0]?.[1]).toBe('voice-state')

    await vi.advanceTimersByTimeAsync(5_000)
    expect(sendReliable).toHaveBeenCalledTimes(2)
    expect(sendReliable.mock.calls[1]?.[0]).toEqual(firstEvent)

    eventHandler?.({
      type: 'VoiceStateAck',
      nonce: firstEvent.nonce,
      channel_id: 'channel-1',
      ok: true,
    })

    await vi.advanceTimersByTimeAsync(15_000)
    expect(sendReliable).toHaveBeenCalledTimes(2)
  })

  it('drops pending ack retry when gateway becomes idle', async () => {
    const { sendVoiceStateUpdate } = await import('./voice-gateway')

    sendVoiceStateUpdate({
      channel_id: 'channel-1',
      self_mute: false,
      self_deaf: false,
    })
    stateHandler?.('idle')

    await vi.advanceTimersByTimeAsync(5_000)
    expect(sendReliable).toHaveBeenCalledTimes(1)
  })

  it('treats matching voice server update as an implicit ack for join intents', async () => {
    const { sendVoiceStateUpdate } = await import('./voice-gateway')

    sendVoiceStateUpdate({
      channel_id: 'channel-1',
      self_mute: false,
      self_deaf: false,
      node: 'node-1',
      force_disconnect: true,
    })

    eventHandler?.({
      type: 'VoiceServerUpdate',
      channel_id: 'channel-1',
      node: 'node-1',
    })

    await vi.advanceTimersByTimeAsync(5_000)
    expect(sendReliable).toHaveBeenCalledTimes(1)
  })

  it('does not treat voice server update as an implicit ack for flag-only updates', async () => {
    const { sendVoiceStateUpdate } = await import('./voice-gateway')

    sendVoiceStateUpdate({
      channel_id: 'channel-1',
      self_mute: true,
      self_deaf: false,
      force_disconnect: false,
    })

    eventHandler?.({
      type: 'VoiceServerUpdate',
      channel_id: 'channel-1',
      node: 'node-1',
    })

    await vi.advanceTimersByTimeAsync(5_000)
    expect(sendReliable).toHaveBeenCalledTimes(2)
  })
})
