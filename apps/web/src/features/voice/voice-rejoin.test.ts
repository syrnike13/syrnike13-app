import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createVoiceRejoinController,
  VOICE_REJOIN_DELAYS_MS,
  VOICE_REJOIN_STEADY_RETRY_MS,
} from './voice-rejoin'

describe('createVoiceRejoinController', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for gateway before attempting rejoin', async () => {
    const attemptRejoin = vi.fn(async () => true)
    let gatewayConnected = false

    const controller = createVoiceRejoinController({
      attemptRejoin,
      onGiveUp: vi.fn(),
      isGatewayConnected: () => gatewayConnected,
    })

    controller.onUnexpectedDisconnect('channel-1')

    await vi.advanceTimersByTimeAsync(VOICE_REJOIN_DELAYS_MS[0])
    expect(attemptRejoin).not.toHaveBeenCalled()

    gatewayConnected = true
    await vi.advanceTimersByTimeAsync(VOICE_REJOIN_DELAYS_MS[0])

    expect(attemptRejoin).toHaveBeenCalledWith('channel-1')
  })

  it('starts the first recoverable rejoin after 500ms', async () => {
    const attemptRejoin = vi.fn(async () => true)

    const controller = createVoiceRejoinController({
      attemptRejoin,
      onGiveUp: vi.fn(),
      isGatewayConnected: () => true,
    })

    controller.onUnexpectedDisconnect('channel-1')

    await vi.advanceTimersByTimeAsync(499)
    expect(attemptRejoin).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(attemptRejoin).toHaveBeenCalledWith('channel-1')
  })

  it('continues recoverable retries after the initial backoff window', async () => {
    const attemptRejoin = vi.fn(async () => false)
    const onGiveUp = vi.fn()

    const controller = createVoiceRejoinController({
      attemptRejoin,
      onGiveUp,
      isGatewayConnected: () => true,
    })

    controller.onUnexpectedDisconnect('channel-1')

    for (let index = 0; index < VOICE_REJOIN_DELAYS_MS.length; index += 1) {
      await vi.advanceTimersByTimeAsync(VOICE_REJOIN_DELAYS_MS[index])
    }
    await vi.advanceTimersByTimeAsync(VOICE_REJOIN_STEADY_RETRY_MS)

    expect(attemptRejoin).toHaveBeenCalledTimes(
      VOICE_REJOIN_DELAYS_MS.length + 1,
    )
    expect(onGiveUp).not.toHaveBeenCalled()
    expect(controller.getPendingChannelId()).toBe('channel-1')
  })

  it('gives up when the pending channel is no longer recoverable', async () => {
    const attemptRejoin = vi.fn(async () => false)
    const onGiveUp = vi.fn()
    let shouldKeepTrying = true

    const controller = createVoiceRejoinController({
      attemptRejoin,
      onGiveUp,
      isGatewayConnected: () => true,
      shouldKeepTrying: () => shouldKeepTrying,
    })

    controller.onUnexpectedDisconnect('channel-1')
    shouldKeepTrying = false

    await vi.advanceTimersByTimeAsync(VOICE_REJOIN_DELAYS_MS[0])

    expect(attemptRejoin).not.toHaveBeenCalled()
    expect(onGiveUp).toHaveBeenCalledTimes(1)
    expect(controller.getPendingChannelId()).toBeNull()
  })

  it('cancel stops pending rejoin', async () => {
    const attemptRejoin = vi.fn(async () => false)

    const controller = createVoiceRejoinController({
      attemptRejoin,
      onGiveUp: vi.fn(),
      isGatewayConnected: () => true,
    })

    controller.onUnexpectedDisconnect('channel-1')
    controller.cancel()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(attemptRejoin).not.toHaveBeenCalled()
    expect(controller.getPendingChannelId()).toBeNull()
  })
})
