// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { StageMediaTile } from '#/components/voice/voice-stage-media-tile'
import type { VoiceStageMediaItem } from '#/features/voice/voice-provider'

vi.mock('#/features/voice/voice-provider', () => ({}))

const screenItem: VoiceStageMediaItem = {
  id: 'remote-user:screen',
  userId: 'remote-user',
  kind: 'screen',
  source: 'screen',
  track: null,
  publication: null,
  isLocal: false,
  subscribed: true,
  live: true,
}

const screenItemWithTrack: VoiceStageMediaItem = {
  ...screenItem,
  track: {
    attach: vi.fn(),
    detach: vi.fn(),
  } as unknown as VoiceStageMediaItem['track'],
}

describe('StageMediaTile', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      value: vi.fn(() => Promise.resolve()),
    })
  })

  it('lets fullscreen media fill the overlay after aspect ratio is disabled', () => {
    render(
      <StageMediaTile
        item={screenItem}
        displayName="Remote User"
        variant="fullscreen"
        onFocus={vi.fn()}
        onOpenPopout={vi.fn()}
        onSetSubscribed={vi.fn()}
      />,
    )

    const tile = screen.getByRole('button')

    expect(tile.className).toContain('size-full')
    expect(tile.style.aspectRatio).toBe('')
  })

  it('keeps popout tile action button clickable', () => {
    const onOpenPopout = vi.fn()

    render(
      <StageMediaTile
        item={screenItemWithTrack}
        displayName="Remote User"
        variant="fullscreen"
        onFocus={vi.fn()}
        onOpenPopout={onOpenPopout}
        onSetSubscribed={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTitle('В отдельном окне'))

    expect(onOpenPopout).toHaveBeenCalledWith(screenItem.id)
  })
})
