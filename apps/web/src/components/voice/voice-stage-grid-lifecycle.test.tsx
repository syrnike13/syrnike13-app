// @vitest-environment jsdom

import { act, render } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { VoiceStageGrid } from './voice-stage-grid'

let resizeCallback: ResizeObserverCallback
let width = 420
let height = 800

class FakeResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback
  }

  observe() {}
  disconnect() {}
  unobserve() {}
}

describe('VoiceStageGrid media lifecycle', () => {
  beforeEach(() => {
    width = 420
    height = 800
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockImplementation(() => width)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockImplementation(() => height)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps media consumers mounted while the column count changes', () => {
    const mounted = vi.fn()
    const unmounted = vi.fn()
    const items = Array.from({ length: 6 }, (_, index) => ({
      id: `stream-${index}`,
    }))

    function MediaTile({ id }: { id: string }) {
      useEffect(() => {
        mounted(id)
        return () => unmounted(id)
      }, [id])
      return <div>{id}</div>
    }

    render(
      <VoiceStageGrid
        items={items}
        renderTile={(item) => <MediaTile id={item.id} />}
      />,
    )
    expect(mounted).toHaveBeenCalledTimes(items.length)

    for (let index = 0; index < 200; index += 1) {
      width = index % 2 === 0 ? 1_400 : 420
      height = index % 2 === 0 ? 500 : 800
      act(() => resizeCallback([], {} as ResizeObserver))
    }

    expect(mounted).toHaveBeenCalledTimes(items.length)
    expect(unmounted).not.toHaveBeenCalled()
  })
})
