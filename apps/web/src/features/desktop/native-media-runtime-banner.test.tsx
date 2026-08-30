// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { NativeMediaRuntimeState } from '@syrnike13/platform'

const unavailableState: NativeMediaRuntimeState = {
  available: false,
  status: 'unavailable',
  restartCount: 0,
  failure: {
    code: 'native_media_unavailable',
    message: 'Native media is unavailable while the v2 engine is rebuilt.',
    retryable: false,
    stage: 'native_runtime',
  },
}

const mediaRuntime = vi.hoisted(() => {
  const listeners = new Set<(value: NativeMediaRuntimeState) => void>()
  return {
    getRuntimeState: vi.fn<() => Promise<NativeMediaRuntimeState>>(),
    retryRuntime: vi.fn(),
    onRuntimeState: vi.fn((listener: (value: NativeMediaRuntimeState) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    emit(next: NativeMediaRuntimeState) {
      for (const listener of listeners) listener(next)
    },
    reset() {
      listeners.clear()
      this.getRuntimeState.mockReset()
      this.retryRuntime.mockReset()
      this.onRuntimeState.mockClear()
    },
  }
})

vi.mock('#/platform/use-platform', () => ({
  usePlatform: () => ({ desktop: { media: mediaRuntime } }),
}))

import { NativeMediaRuntimeBanner } from './native-media-runtime-banner'

describe('NativeMediaRuntimeBanner', () => {
  afterEach(cleanup)

  beforeEach(() => {
    mediaRuntime.reset()
    mediaRuntime.getRuntimeState.mockResolvedValue(unavailableState)
  })

  it('shows the finite unavailable state without offering a restart', async () => {
    render(<NativeMediaRuntimeBanner />)

    expect(
      await screen.findByText(
        'Нативные медиа временно недоступны, пока мы пересобираем движок.',
      ),
    ).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(mediaRuntime.retryRuntime).not.toHaveBeenCalled()
  })

  it('accepts a pushed unavailable state while the initial request is pending', async () => {
    mediaRuntime.getRuntimeState.mockImplementationOnce(() => new Promise(() => {}))
    render(<NativeMediaRuntimeBanner />)

    await act(async () => {
      mediaRuntime.emit(unavailableState)
    })

    expect(
      screen.getByText(
        'Нативные медиа временно недоступны, пока мы пересобираем движок.',
      ),
    ).toBeTruthy()
  })
})
