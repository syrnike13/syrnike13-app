// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useVoiceStageFocusSizing } from './use-voice-stage-focus-sizing'

let resizeCallback: ResizeObserverCallback

class FakeResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback
  }

  observe() {}
  disconnect() {}
  unobserve() {}
}

describe('useVoiceStageFocusSizing resize stability', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not rerender for repeated callbacks with the same size', () => {
    const element = {
      getBoundingClientRect: () => ({
        width: 1280,
        height: 720,
      }),
    } as HTMLElement
    let renders = 0

    renderHook(() => {
      renders += 1
      return useVoiceStageFocusSizing(
        { current: element },
        16 / 9,
        5,
        false,
      )
    })
    const stableRenderCount = renders

    for (let index = 0; index < 1_000; index += 1) {
      act(() => resizeCallback([], {} as ResizeObserver))
    }

    expect(renders).toBe(stableRenderCount)
  })
})
