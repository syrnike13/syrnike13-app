import { describe, expect, it, vi } from 'vitest'

import { Track } from 'livekit-client'

import {
  applyStageScreenPublicationSubscription,
  setStageScreenSubscription,
  shouldSubscribeStageScreen,
} from '#/features/voice/voice-stage-subscription'
import type { StageMediaItem } from '#/features/voice/voice-stage-media'

function screenItem(
  fields: Partial<StageMediaItem<unknown, { setSubscribed: (value: boolean) => void }>>,
): StageMediaItem<unknown, { setSubscribed: (value: boolean) => void }> {
  return {
    id: 'user:screen',
    userId: 'user',
    kind: 'screen',
    source: 'screen',
    isLocal: false,
    subscribed: true,
    live: true,
    ...fields,
  }
}

describe('setStageScreenSubscription', () => {
  it('uses LiveKit subscription for remote screen share', () => {
    const setSubscribed = vi.fn()

    const action = setStageScreenSubscription(
      screenItem({ publication: { setSubscribed } }),
      false,
    )

    expect(setSubscribed).toHaveBeenCalledWith(false)
    expect(action).toBe('none')
  })

  it('returns a stop action for local screen share unsubscribe', () => {
    const action = setStageScreenSubscription(
      screenItem({ isLocal: true }),
      false,
    )

    expect(action).toBe('stop-local-screen')
  })

  it('ignores non-screen items', () => {
    const action = setStageScreenSubscription(
      {
        id: 'user:camera',
        userId: 'user',
        kind: 'camera',
        source: 'camera',
        isLocal: false,
        live: true,
      },
      false,
    )

    expect(action).toBe('none')
  })
})

describe('shouldSubscribeStageScreen', () => {
  it('keeps remote screen shares unsubscribed until the user opts in', () => {
    expect(
      shouldSubscribeStageScreen({
        isLocal: false,
        mediaId: 'remote-user:screen',
        watchedRemoteScreenIds: new Set(),
      }),
    ).toBe(false)
  })

  it('keeps local screen shares subscribed', () => {
    expect(
      shouldSubscribeStageScreen({
        isLocal: true,
        mediaId: 'local-user:screen',
        watchedRemoteScreenIds: new Set(),
      }),
    ).toBe(true)
  })

  it('subscribes remote screen shares after the user opts in', () => {
    expect(
      shouldSubscribeStageScreen({
        isLocal: false,
        mediaId: 'remote-user:screen',
        watchedRemoteScreenIds: new Set(['remote-user:screen']),
      }),
    ).toBe(true)
  })
})

describe('applyStageScreenPublicationSubscription', () => {
  it('unsubscribes remote screen video publication', () => {
    const setSubscribed = vi.fn()

    applyStageScreenPublicationSubscription(
      {
        source: Track.Source.ScreenShare,
        isSubscribed: true,
        setSubscribed,
      },
      false,
    )

    expect(setSubscribed).toHaveBeenCalledWith(false)
  })

  it('unsubscribes remote screen audio publication', () => {
    const setSubscribed = vi.fn()

    applyStageScreenPublicationSubscription(
      {
        source: Track.Source.ScreenShareAudio,
        isSubscribed: true,
        setSubscribed,
      },
      false,
    )

    expect(setSubscribed).toHaveBeenCalledWith(false)
  })

  it('does not touch microphone publications', () => {
    const setSubscribed = vi.fn()

    applyStageScreenPublicationSubscription(
      {
        source: Track.Source.Microphone,
        isSubscribed: true,
        setSubscribed,
      },
      false,
    )

    expect(setSubscribed).not.toHaveBeenCalled()
  })
})
