import { describe, expect, it } from 'vitest'

import {
  DEFAULT_EASTER_CHANCE,
  DEFAULT_SOUND_AUTHOR_PACK_ID,
  UI_SOUND_EVENTS,
  authorSoundPackOptions,
  eventSoundPackOptions,
  resolveSoundClip,
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

  it('covers every UI sound event with normal and easter clips', () => {
    expect(validateSoundPackCatalog()).toEqual([])

    const resolvedEvents = new Set(
      UI_SOUND_EVENTS.map((eventId) =>
        resolveSoundClip({
          eventId,
          authorPackId: DEFAULT_SOUND_AUTHOR_PACK_ID,
          random: () => 1,
        })?.eventId,
      ),
    )

    expect(resolvedEvents).toEqual(new Set(UI_SOUND_EVENTS))
  })

  it('ignores unknown event pack ids and keeps runtime event packs out of user options', () => {
    const normalMessage = resolveSoundClip({
      eventId: 'message.default',
      authorPackId: DEFAULT_SOUND_AUTHOR_PACK_ID,
      eventPackId: 'winter',
      random: () => 1,
    })

    expect(normalMessage?.packKind).toBe('author')
    expect(eventSoundPackOptions()).toEqual([])
  })

  it('resolves easter variants with a 0.25 percent chance', () => {
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

    expect(easter?.variant).toBe('easter')
    expect(normal?.variant).toBe('normal')
  })
})
