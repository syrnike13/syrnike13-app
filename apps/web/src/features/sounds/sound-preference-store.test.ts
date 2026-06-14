import { describe, expect, it } from 'vitest'

import { DEFAULT_SOUND_AUTHOR_PACK_ID } from './sound-packs'
import {
  DEFAULT_SOUND_PREFERENCES,
  normalizeSoundPreferences,
  normalizeSoundPreferencesPatch,
  soundPreferenceStore,
} from './sound-preference-store'

describe('sound preferences', () => {
  it('defaults to enabled UI sounds and the default author pack', () => {
    expect(normalizeSoundPreferences(undefined)).toEqual(
      DEFAULT_SOUND_PREFERENCES,
    )
  })

  it('keeps valid author pack preferences and clamps volume', () => {
    expect(
      normalizeSoundPreferences({
        enabled: false,
        authorPackId: DEFAULT_SOUND_AUTHOR_PACK_ID,
        volume: 1.7,
        eventVolumes: {
          'voice.mute': 0.25,
          'voice.unmute': -1,
          broken: 'nope',
        },
        easterEnabled: false,
      }),
    ).toEqual({
      enabled: false,
      authorPackId: DEFAULT_SOUND_AUTHOR_PACK_ID,
      volume: 1,
      eventVolumes: {
        'voice.mute': 0.25,
        'voice.unmute': 0,
      },
      easterEnabled: false,
    })
  })

  it('rejects event pack ids from user preferences', () => {
    expect(
      normalizeSoundPreferences({
        authorPackId: 'winter',
      }).authorPackId,
    ).toBe(DEFAULT_SOUND_PREFERENCES.authorPackId)
  })

  it('normalizes patches without filling unrelated fields', () => {
    expect(
      normalizeSoundPreferencesPatch({
        authorPackId: DEFAULT_SOUND_AUTHOR_PACK_ID,
        volume: -1,
        eventVolumes: {
          'voice.mute': 2,
        },
      }),
    ).toEqual({
      authorPackId: DEFAULT_SOUND_AUTHOR_PACK_ID,
      volume: 0,
      eventVolumes: {
        'voice.mute': 1,
      },
    })
  })

  it('returns a stable snapshot while preferences do not change', () => {
    expect(soundPreferenceStore.getState()).toBe(soundPreferenceStore.getState())
  })
})
