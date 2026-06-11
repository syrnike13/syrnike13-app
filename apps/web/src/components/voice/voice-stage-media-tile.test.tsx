// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StageMediaTile } from '#/components/voice/voice-stage-media-tile'
import type { VoiceStageMediaItem } from '#/features/voice/voice-context'

vi.mock('#/features/voice/voice-context', () => ({}))

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
    attach: vi.fn((element: HTMLVideoElement) => element),
    detach: vi.fn(),
  } as VoiceStageMediaItem['track'],
}

describe('StageMediaTile', () => {
  beforeEach(() => {
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
    cleanup()
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
          self_mute: false,
          self_deaf: false,
          version: 1,
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

  it('renders a loading screen tile while subscribed but the track is not ready', () => {
    render(
      <StageMediaTile
        item={{ ...screenItem, track: null, subscribed: true, live: true }}
        displayName="исочка"
        variant="grid"
        participant={{
          id: 'remote-user',
          joined_at: 1,
          self_mute: false,
          self_deaf: false,
          version: 1,
          server_muted: false,
          server_deafened: false,
          camera: false,
          screensharing: true,
        }}
        onFocus={vi.fn()}
        onSetSubscribed={vi.fn()}
      />,
    )

    expect(screen.getByRole('status', { name: 'Подключение к стриму' })).toBeTruthy()
    expect(screen.getByText('исочка')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Смотреть' })).toBeNull()
    expect(screen.queryByText('Экран исочка')).toBeNull()
  })

  it('renders an unsubscribed screen tile with a watch button and owner label', () => {
    const onSetSubscribed = vi.fn()

    render(
      <StageMediaTile
        item={{ ...screenItem, subscribed: false }}
        displayName="nioh13"
        variant="grid"
        participant={{
          id: 'remote-user',
          joined_at: 1,
          self_mute: false,
          self_deaf: false,
          version: 1,
          server_muted: false,
          server_deafened: false,
          camera: false,
          screensharing: true,
        }}
        onFocus={vi.fn()}
        onSetSubscribed={onSetSubscribed}
      />,
    )

    expect(screen.getByRole('button', { name: 'Смотреть' })).toBeTruthy()
    expect(screen.getByText('nioh13')).toBeTruthy()
    expect(screen.queryByLabelText('В эфире')).toBeNull()
    expect(screen.queryByText('Экран nioh13')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Смотреть' }))
    expect(onSetSubscribed).toHaveBeenCalledWith(screenItem.id, true)
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
