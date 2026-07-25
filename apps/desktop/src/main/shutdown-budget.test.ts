import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  APP_SHUTDOWN_TIMEOUT_MS,
  disposeWithinDesktopShutdownBudget,
  VOICE_SHUTDOWN_GRACE_MS,
} from './shutdown-budget'

describe('disposeWithinDesktopShutdownBudget', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('releases a shutdown with hung disposal work before five seconds', async () => {
    vi.useFakeTimers()
    const disposeRemaining = vi.fn(
      () => new Promise<void>(() => undefined),
    )
    let settled = false

    const shutdown = disposeWithinDesktopShutdownBudget({
      disposeVoice: () => new Promise<void>(() => undefined),
      disposeRemaining,
      onVoiceDisposeError: vi.fn(),
      onVoiceDeadlineExceeded: vi.fn(),
      onDeadlineSettled: vi.fn(),
    }).then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(VOICE_SHUTDOWN_GRACE_MS)
    expect(disposeRemaining).toHaveBeenCalledOnce()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(
      APP_SHUTDOWN_TIMEOUT_MS - VOICE_SHUTDOWN_GRACE_MS - 1,
    )
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await shutdown
    expect(settled).toBe(true)
    expect(APP_SHUTDOWN_TIMEOUT_MS).toBeLessThan(5_000)
  })

  it('does not wait for the voice grace period after voice disposal completes', async () => {
    vi.useFakeTimers()
    const disposeRemaining = vi.fn(async () => undefined)
    const onVoiceDeadlineExceeded = vi.fn()

    await disposeWithinDesktopShutdownBudget({
      disposeVoice: async () => undefined,
      disposeRemaining,
      onVoiceDisposeError: vi.fn(),
      onVoiceDeadlineExceeded,
      onDeadlineSettled: vi.fn(),
    })

    expect(disposeRemaining).toHaveBeenCalledOnce()
    expect(onVoiceDeadlineExceeded).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
