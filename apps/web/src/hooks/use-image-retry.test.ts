// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { IMAGE_RETRY_DELAYS_MS, useImageRetry } from '#/hooks/use-image-retry'

describe('useImageRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries a failed image after a backoff delay', () => {
    const { result } = renderHook(() => useImageRetry('/avatars/a'))

    act(() => result.current.onError())
    expect(result.current).toMatchObject({ attempt: 0, failed: true })

    act(() => vi.advanceTimersByTime(IMAGE_RETRY_DELAYS_MS[0]))
    expect(result.current).toMatchObject({ attempt: 1, failed: false })
  })

  it('waits for the network after the last scheduled retry', () => {
    const { result } = renderHook(() => useImageRetry('/avatars/a'))

    for (const delay of IMAGE_RETRY_DELAYS_MS) {
      act(() => result.current.onError())
      act(() => vi.advanceTimersByTime(delay))
    }
    act(() => result.current.onError())
    act(() => vi.advanceTimersByTime(10 * 60_000))
    expect(result.current.failed).toBe(true)

    act(() => window.dispatchEvent(new Event('online')))
    expect(result.current).toMatchObject({
      attempt: IMAGE_RETRY_DELAYS_MS.length + 1,
      failed: false,
    })
  })

  it('starts over when the source changes', () => {
    const { result, rerender } = renderHook(
      ({ src }) => useImageRetry(src),
      { initialProps: { src: '/avatars/a' } },
    )

    act(() => result.current.onError())
    rerender({ src: '/avatars/b' })
    expect(result.current).toMatchObject({ attempt: 0, failed: false })
  })
})
