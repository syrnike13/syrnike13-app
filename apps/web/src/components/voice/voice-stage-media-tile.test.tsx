// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
    mediaStreamTrack: {},
  } as VoiceStageMediaItem['track'],
}

describe('StageMediaTile', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'MediaStream',
      vi.fn(function MediaStreamStub(this: { tracks: unknown[] }, tracks) {
        this.tracks = tracks
      }),
    )
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      value: vi.fn(() => Promise.resolve()),
    })
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
      configurable: true,
      value: vi.fn(),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lets fullscreen media fill the overlay after aspect ratio is disabled', () => {
    render(
      <StageMediaTile
        item={screenItem}
        displayName="Remote User"
        variant="fullscreen"
        onFocus={vi.fn()}
        onSetSubscribed={vi.fn()}
      />,
    )

    const tile = screen.getByRole('button')

    expect(tile.className).toContain('size-full')
    expect(tile.style.aspectRatio).toBe('')
  })

  it('hides the media label overlay in focus mode', () => {
    render(
      <StageMediaTile
        item={screenItem}
        displayName="Remote User"
        variant="focus"
        onFocus={vi.fn()}
        onSetSubscribed={vi.fn()}
      />,
    )

    expect(screen.queryByText('Экран Remote User')).toBeNull()
  })

  it('hides the on-air badge on the tile in focus mode', () => {
    render(
      <StageMediaTile
        item={screenItem}
        displayName="Remote User"
        variant="focus"
        participant={{
          id: 'remote-user',
          joined_at: 1,
          is_publishing: true,
          is_receiving: true,
          server_muted: false,
          server_deafened: false,
          camera: false,
          screensharing: true,
        }}
        onFocus={vi.fn()}
        onSetSubscribed={vi.fn()}
      />,
    )

    expect(screen.queryByLabelText('В эфире')).toBeNull()
  })

  it('focuses the tile when the user clicks directly on video', () => {
    const onFocus = vi.fn()

    render(
      <StageMediaTile
        item={screenItemWithTrack}
        displayName="Remote User"
        variant="grid"
        onFocus={onFocus}
        onSetSubscribed={vi.fn()}
      />,
    )

    fireEvent.click(document.querySelector('video')!)

    expect(onFocus).toHaveBeenCalledWith(screenItem.id)
  })
})
