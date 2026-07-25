// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NativeMediaRuntimeState } from '@syrnike13/platform'

const mediaRuntime = vi.hoisted(() => {
  let state: NativeMediaRuntimeState = {
    available: true,
    status: 'degraded',
    restartCount: 3,
    degradedRetryAttempt: 1,
    nextRetryAt: 30_000,
  }
  const listeners = new Set<(value: NativeMediaRuntimeState) => void>()
  return {
    getRuntimeState: vi.fn(async () => state),
    retryRuntime: vi.fn(async () => {
      state = { available: true, status: 'ready', restartCount: 4 }
      for (const listener of listeners) listener(state)
      return state
    }),
    onRuntimeState: vi.fn((listener: (value: NativeMediaRuntimeState) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    emit(next: NativeMediaRuntimeState) {
      state = next
      for (const listener of listeners) listener(next)
    },
    reset() {
      state = {
        available: true,
        status: 'degraded',
        restartCount: 3,
        degradedRetryAttempt: 1,
        nextRetryAt: 30_000,
      }
      listeners.clear()
      this.getRuntimeState.mockClear()
      this.retryRuntime.mockClear()
      this.onRuntimeState.mockClear()
    },
  }
})

vi.mock('#/platform/use-platform', () => ({
  usePlatform: () => ({ desktop: { media: mediaRuntime } }),
}))

import { NativeMediaRuntimeBanner } from './native-media-runtime-banner'

describe('NativeMediaRuntimeBanner', () => {
  beforeEach(() => {
    mediaRuntime.reset()
  })

  it('shows degraded state and delegates the retry action', async () => {
    render(<NativeMediaRuntimeBanner />)
    expect(
      await screen.findByText(
        'Микрофон, камера и демонстрация экрана временно недоступны.',
      ),
    ).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Перезапустить медиа' }))
    await act(async () => {})

    expect(mediaRuntime.retryRuntime).toHaveBeenCalledTimes(1)
    expect(
      screen.queryByText(
        'Микрофон, камера и демонстрация экрана временно недоступны.',
      ),
    ).toBeNull()
  })

  it('shows automatic recovery without a duplicate manual action', async () => {
    render(<NativeMediaRuntimeBanner />)
    await act(async () => {
      mediaRuntime.emit({
        available: true,
        status: 'recovering',
        restartCount: 4,
      })
    })

    expect(
      screen.getByText(
        'Восстанавливаем микрофон, камеру и демонстрацию экрана…',
      ),
    ).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('does not let a stale initial snapshot overwrite a newer pushed state', async () => {
    let resolveInitial!: (state: NativeMediaRuntimeState) => void
    mediaRuntime.getRuntimeState.mockImplementationOnce(
      () =>
        new Promise<NativeMediaRuntimeState>((resolve) => {
          resolveInitial = resolve
        }),
    )
    render(<NativeMediaRuntimeBanner />)

    await act(async () => {
      mediaRuntime.emit({
        available: true,
        status: 'ready',
        restartCount: 4,
      })
    })
    await act(async () => {
      resolveInitial({
        available: true,
        status: 'degraded',
        restartCount: 3,
      })
    })

    expect(
      screen.queryByText(
        'Микрофон, камера и демонстрация экрана временно недоступны.',
      ),
    ).toBeNull()
  })
})
