import { afterEach, describe, expect, it, vi } from 'vitest'
import { Effect } from 'effect'

import {
  APP_SHUTDOWN_TIMEOUT_MS,
  disposeWithinDesktopShutdownBudget,
  disposeWithinDesktopShutdownBudgetEffect,
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
      forceExit: vi.fn(),
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
      forceExit: vi.fn(),
    })

    expect(disposeRemaining).toHaveBeenCalledOnce()
    expect(onVoiceDeadlineExceeded).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['voice', 'remaining'])('forces the overall process deadline 100/100 times with hung %s finalizers', async scope => {
    vi.useFakeTimers()
    for (let attempt = 0; attempt < 100; attempt += 1) {
      let finishFinalizer = () => {}
      const finalizerStarted = vi.fn()
      const forceExit = vi.fn()
      const settled = vi.fn()
      const hung = Effect.never.pipe(Effect.ensuring(Effect.promise(() => {
        finalizerStarted()
        return new Promise<void>(resolve => { finishFinalizer = resolve })
      })))
      const disposal = Effect.runPromise(disposeWithinDesktopShutdownBudgetEffect({
        disposeVoice: scope === 'voice' ? hung : Effect.void,
        disposeRemaining: scope === 'remaining' ? hung : Effect.void,
        onVoiceDisposeError: vi.fn(),
        onVoiceDeadlineExceeded: vi.fn(),
        onDeadlineSettled: settled,
        forceExit,
      }))
      try {
        await vi.advanceTimersByTimeAsync(VOICE_SHUTDOWN_GRACE_MS)
        if (scope === 'voice') expect(finalizerStarted).toHaveBeenCalledOnce()
        expect(settled).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(APP_SHUTDOWN_TIMEOUT_MS - VOICE_SHUTDOWN_GRACE_MS - 1)
        expect(forceExit).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(forceExit).toHaveBeenCalledOnce()
        expect(finalizerStarted).toHaveBeenCalledOnce()
        expect(settled).not.toHaveBeenCalled()
      } finally {
        finishFinalizer()
        await disposal
      }
      expect(settled).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    }
  })
})
