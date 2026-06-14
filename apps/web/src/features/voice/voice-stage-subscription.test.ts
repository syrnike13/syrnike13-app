import { describe, expect, it, vi } from 'vitest'

import { Track } from 'livekit-client'

import {
  applyStageScreenPublicationSubscription,
  pruneWatchedRemoteScreenIds,
  resolveStageScreenSubscriptionTarget,
  setStageScreenSubscription,
  setRemoteScreenWatchIntent,
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

  it('keeps native screen shares from the current user subscribed', () => {
    expect(
      shouldSubscribeStageScreen({
        isLocal: false,
        mediaId: 'local-user:screen',
        currentUserIds: new Set(['local-user']),
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

  it('subscribes remote screen shares while join is still settling', () => {
    expect(
      shouldSubscribeStageScreen({
        isLocal: false,
        mediaId: 'remote-user:screen',
        watchedRemoteScreenIds: new Set(),
        pendingScreenWatchIds: new Set(['remote-user:screen']),
      }),
    ).toBe(true)
  })
})

describe('setRemoteScreenWatchIntent', () => {
  it('clears both watched and pending intent when unsubscribing', () => {
    const watched = new Set(['remote-user:screen'])
    const pending = new Set(['remote-user:screen'])

    setRemoteScreenWatchIntent(watched, pending, 'remote-user:screen', false)

    expect(watched).toEqual(new Set())
    expect(pending).toEqual(new Set())
    expect(
      shouldSubscribeStageScreen({
        isLocal: false,
        mediaId: 'remote-user:screen',
        watchedRemoteScreenIds: watched,
        pendingScreenWatchIds: pending,
      }),
    ).toBe(false)
  })
})

describe('resolveStageScreenSubscriptionTarget', () => {
  it('uses the visible item when it is available', () => {
    expect(
      resolveStageScreenSubscriptionTarget(
        screenItem({
          id: 'remote-user:screen',
          userId: 'remote-user',
          isLocal: false,
        }),
        'ignored:screen',
        new Set(),
      ),
    ).toEqual({
      mediaId: 'remote-user:screen',
      userId: 'remote-user',
      isLocal: false,
    })
  })

  it('resolves a hidden remote screen target from media id', () => {
    expect(
      resolveStageScreenSubscriptionTarget(
        null,
        'remote-user:screen',
        new Set(['local-user']),
      ),
    ).toEqual({
      mediaId: 'remote-user:screen',
      userId: 'remote-user',
      isLocal: false,
    })
  })

  it('resolves a hidden local screen target from current user ids', () => {
    expect(
      resolveStageScreenSubscriptionTarget(
        null,
        'local-user:screen',
        new Set(['local-user']),
      ),
    ).toEqual({
      mediaId: 'local-user:screen',
      userId: 'local-user',
      isLocal: true,
    })
  })
})

describe('pruneWatchedRemoteScreenIds', () => {
  it('keeps pending watch intent while the participant is still in the room', () => {
    const watched = new Set(['remote-user:screen'])
    const pending = new Set(['remote-user:screen'])

    pruneWatchedRemoteScreenIds(
      watched,
      pending,
      new Set(),
      new Set(['remote-user']),
    )

    expect(watched).toEqual(new Set(['remote-user:screen']))
    expect(pending).toEqual(new Set(['remote-user:screen']))
  })

  it('removes watch intent after the participant leaves the room', () => {
    const watched = new Set(['remote-user:screen'])
    const pending = new Set<string>()

    pruneWatchedRemoteScreenIds(watched, pending, new Set(), new Set())

    expect(watched).toEqual(new Set())
  })

  it('removes pending watch intent after the participant leaves the room', () => {
    const watched = new Set(['remote-user:screen'])
    const pending = new Set(['remote-user:screen'])

    pruneWatchedRemoteScreenIds(
      watched,
      pending,
      new Set(),
      new Set(),
    )

    expect(watched).toEqual(new Set())
    expect(pending).toEqual(new Set())
  })

  it('keeps visible remote screen watches', () => {
    const watched = new Set(['remote-user:screen'])
    const pending = new Set<string>()

    pruneWatchedRemoteScreenIds(
      watched,
      pending,
      new Set(['remote-user:screen']),
      new Set(['remote-user']),
    )

    expect(watched).toEqual(new Set(['remote-user:screen']))
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
