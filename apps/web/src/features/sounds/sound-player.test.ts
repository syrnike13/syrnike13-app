import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_SOUND_AUTHOR_PACK_ID } from './sound-packs'
import { createSoundPlayer } from './sound-player'

describe('sound player', () => {
  it('plays resolved event clips with preference volume', () => {
    const play = vi.fn(() => Promise.resolve())
    const audio = { volume: 0, preload: '', play }
    const player = createSoundPlayer({
      createAudio: vi.fn(() => audio),
      getPreferences: () => ({
        enabled: true,
        authorPackId: DEFAULT_SOUND_AUTHOR_PACK_ID,
        volume: 0.4,
        eventVolumes: {
          'voice.mute': 0.5,
        },
        easterEnabled: true,
      }),
      getEventPackId: () => null,
      isAppEasterModeEnabled: () => false,
    })

    player.play('voice.mute')

    expect(audio.volume).toBe(0.2)
    expect(audio.preload).toBe('auto')
    expect(play).toHaveBeenCalledTimes(1)
  })

  it('does not create audio when the selected pack has no clip for an event', () => {
    const createAudio = vi.fn()
    const player = createSoundPlayer({
      createAudio,
      getPreferences: () => ({
        enabled: true,
        authorPackId: DEFAULT_SOUND_AUTHOR_PACK_ID,
        volume: 1,
        eventVolumes: {},
        easterEnabled: true,
      }),
      getEventPackId: () => null,
      isAppEasterModeEnabled: () => false,
    })

    player.play('message.default')

    expect(createAudio).not.toHaveBeenCalled()
  })

  it('does not create audio when sounds are disabled', () => {
    const createAudio = vi.fn()
    const player = createSoundPlayer({
      createAudio,
      getPreferences: () => ({
        enabled: false,
        authorPackId: DEFAULT_SOUND_AUTHOR_PACK_ID,
        volume: 1,
        eventVolumes: {},
        easterEnabled: true,
      }),
      getEventPackId: () => null,
      isAppEasterModeEnabled: () => false,
    })

    player.play('message.default')

    expect(createAudio).not.toHaveBeenCalled()
  })

  it('plays easter event clips while app easter mode is enabled', () => {
    const play = vi.fn(() => Promise.resolve())
    const audio = { volume: 0, preload: '', play }
    const createAudio = vi.fn(() => audio)
    const player = createSoundPlayer({
      createAudio,
      getPreferences: () => ({
        enabled: true,
        authorPackId: DEFAULT_SOUND_AUTHOR_PACK_ID,
        volume: 1,
        eventVolumes: {},
        easterEnabled: true,
      }),
      getEventPackId: () => null,
      isAppEasterModeEnabled: () => true,
    })

    player.play('message.default')

    expect(createAudio).toHaveBeenCalledWith('/sounds/ui/easter/notification.ogg')
    expect(audio.volume).toBe(1)
    expect(audio.preload).toBe('auto')
    expect(play).toHaveBeenCalledTimes(1)
  })
})
