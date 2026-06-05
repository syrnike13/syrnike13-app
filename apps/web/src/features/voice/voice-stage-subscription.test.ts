import { describe, expect, it, vi } from 'vitest'

import { setStageScreenSubscription } from '#/features/voice/voice-stage-subscription'
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
