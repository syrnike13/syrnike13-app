import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createVoiceRejoinController,
  VOICE_REJOIN_DELAYS_MS,
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

  it('retries with backoff and gives up after max attempts', async () => {
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

    expect(attemptRejoin).toHaveBeenCalledTimes(VOICE_REJOIN_DELAYS_MS.length)
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
