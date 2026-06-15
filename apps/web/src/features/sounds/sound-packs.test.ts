import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SOUND_AUTHOR_PACK_ID,
  authorSoundPackOptions,
  eventSoundPackOptions,
  resolveSoundClip,
  soundEventVolumeOptions,
  validateSoundPackCatalog,
} from './sound-packs'

describe('sound pack catalog', () => {
  it('keeps author packs selectable and event packs separate', () => {
    expect(authorSoundPackOptions().map((pack) => pack.id)).toContain(
      DEFAULT_SOUND_AUTHOR_PACK_ID,
    )
    expect(authorSoundPackOptions().every((pack) => pack.kind === 'author')).toBe(
      true,
    )
    expect(eventSoundPackOptions().every((pack) => pack.kind === 'event')).toBe(
      true,
    )
  })

  it('keeps the catalog valid without pretending missing sounds exist', () => {
    expect(validateSoundPackCatalog()).toEqual([])

    expect(
      soundEventVolumeOptions(DEFAULT_SOUND_AUTHOR_PACK_ID).map((event) => event.id),
    ).toEqual([
      'voice.user_join',
      'voice.user_leave',
      'voice.user_move',
      'voice.mute',
      'voice.unmute',
      'voice.deafen',
      'voice.undeafen',
      'voice.disconnect',
      'call.connected',
      'call.ended',
      'screen_share.started',
      'screen_share.stopped',
    ])

    expect(
      resolveSoundClip({
        eventId: 'message.default',
        authorPackId: DEFAULT_SOUND_AUTHOR_PACK_ID,
      }),
    ).toBeNull()
    expect(
      resolveSoundClip({
        eventId: 'camera.started',
        authorPackId: DEFAULT_SOUND_AUTHOR_PACK_ID,
      }),
    ).toBeNull()
  })

  it('ignores unknown event pack ids and keeps runtime event packs out of user options', () => {
    const normalMessage = resolveSoundClip({
      eventId: 'voice.mute',
      authorPackId: DEFAULT_SOUND_AUTHOR_PACK_ID,
      eventPackId: 'winter',
    })

    expect(normalMessage?.packKind).toBe('author')
    expect(eventSoundPackOptions()).toEqual([])
  })

  it('uses easter sounds deterministically while app easter mode is enabled', () => {
    expect(
      resolveSoundClip({
        eventId: 'message.default',
        authorPackId: DEFAULT_SOUND_AUTHOR_PACK_ID,
      }),
    ).toBeNull()

    const notification = resolveSoundClip({
      eventId: 'message.default',
      authorPackId: DEFAULT_SOUND_AUTHOR_PACK_ID,
      appEasterModeEnabled: true,
    })
    const voiceJoin = resolveSoundClip({
      eventId: 'voice.user_join',
      authorPackId: DEFAULT_SOUND_AUTHOR_PACK_ID,
      appEasterModeEnabled: true,
    })
    const mute = resolveSoundClip({
      eventId: 'voice.mute',
      authorPackId: DEFAULT_SOUND_AUTHOR_PACK_ID,
      appEasterModeEnabled: true,
    })

    expect(notification).toMatchObject({
      variant: 'easter',
      src: '/sounds/ui/easter/notification.ogg',
    })
    expect(voiceJoin).toMatchObject({
      variant: 'easter',
      src: '/sounds/ui/easter/voice-channel-connected.ogg',
    })
    expect(mute).toMatchObject({
      variant: 'easter',
      src: '/sounds/ui/easter/microphone-muted.ogg',
    })
  })

  it('keeps default sounds in regular mode even when easter sounds exist', () => {
    const normal = resolveSoundClip({
      eventId: 'voice.user_join',
      authorPackId: DEFAULT_SOUND_AUTHOR_PACK_ID,
    })

    expect(normal?.variant).toBe('normal')
    expect(normal?.src).toBe('/sounds/ui/default/user-join.ogg')
  })
})
