// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { VoiceStageFocusStage } from './voice-stage-focus-stage'

class FakeResizeObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}

describe('VoiceStageFocusStage media lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({
        width: 1280,
        height: 720,
        x: 0,
        y: 0,
        top: 0,
        right: 1280,
        bottom: 720,
        left: 0,
        toJSON: () => ({}),
      })
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('releases hidden filmstrip media after the collapse transition', () => {
    const mounted = new Set<string>()
    const items = [
      { id: 'focused' },
      { id: 'first-strip' },
      { id: 'second-strip' },
    ]

    function MediaTile({ id }: { id: string }) {
      useEffect(() => {
        mounted.add(id)
        return () => {
          mounted.delete(id)
        }
      }, [id])
      return <div>{id}</div>
    }

    render(
      <VoiceStageFocusStage
        focusedItem={items[0]}
        mediaItems={items}
        chromeVisible
        renderTile={(item) => <MediaTile id={item.id} />}
      />,
    )
    expect(mounted).toEqual(new Set(['focused', 'first-strip', 'second-strip']))

    fireEvent.click(screen.getByRole('button', {
      name: 'Убрать участников',
    }))
    expect(mounted).toEqual(new Set(['focused', 'first-strip', 'second-strip']))

    act(() => vi.advanceTimersByTime(200))
    expect(mounted).toEqual(new Set(['focused']))

    fireEvent.click(screen.getByRole('button', {
      name: 'Показать участников',
    }))
    expect(mounted).toEqual(new Set(['focused', 'first-strip', 'second-strip']))
  })
})
