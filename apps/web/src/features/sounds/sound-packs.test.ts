import { describe, expect, it } from 'vitest'

import {
  DEFAULT_EASTER_CHANCE,
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
      'screen_share.viewer_join',
      'screen_share.viewer_leave',
    ])

    expect(
      resolveSoundClip({
        eventId: 'message.default',
        authorPackId: DEFAULT_SOUND_AUTHOR_PACK_ID,
        random: () => 1,
      }),
    ).toBeNull()
    expect(
      resolveSoundClip({
        eventId: 'camera.started',
        authorPackId: DEFAULT_SOUND_AUTHOR_PACK_ID,
        random: () => 1,
      }),
    ).toBeNull()
  })

  it('ignores unknown event pack ids and keeps runtime event packs out of user options', () => {
    const normalMessage = resolveSoundClip({
      eventId: 'voice.mute',
      authorPackId: DEFAULT_SOUND_AUTHOR_PACK_ID,
      eventPackId: 'winter',
      random: () => 1,
    })

    expect(normalMessage?.packKind).toBe('author')
    expect(eventSoundPackOptions()).toEqual([])
  })

  it('keeps the 0.25 percent easter chance but stays normal until easter files exist', () => {
    const easter = resolveSoundClip({
      eventId: 'voice.user_join',
      authorPackId: DEFAULT_SOUND_AUTHOR_PACK_ID,
      random: () => DEFAULT_EASTER_CHANCE - 0.0001,
    })
    const normal = resolveSoundClip({
      eventId: 'voice.user_join',
      authorPackId: DEFAULT_SOUND_AUTHOR_PACK_ID,
      random: () => DEFAULT_EASTER_CHANCE + 0.0001,
    })

    expect(easter?.variant).toBe('normal')
    expect(normal?.variant).toBe('normal')
  })
})
