// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useVoiceStageGridLayout } from './use-voice-stage-grid-layout'

let resizeCallback: ResizeObserverCallback

class FakeResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback
  }

  observe() {}
  disconnect() {}
  unobserve() {}
}

describe('useVoiceStageGridLayout resize stability', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not rerender for repeated callbacks with the same size', () => {
    const element = {
      clientWidth: 1280,
      clientHeight: 720,
    } as HTMLElement
    let renders = 0

    renderHook(() => {
      renders += 1
      return useVoiceStageGridLayout({ current: element }, 6)
    })
    const stableRenderCount = renders

    for (let index = 0; index < 1_000; index += 1) {
      act(() => resizeCallback([], {} as ResizeObserver))
    }

    expect(renders).toBe(stableRenderCount)
  })
})
