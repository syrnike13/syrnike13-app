import { describe, expect, it } from 'vitest'
import type { DesktopDisplayMediaSource } from '@syrnike13/platform'

import {
  canRequestSourceAudio,
  sourceAudioLabel,
} from './desktop-screen-share-picker'

function source(
  type: DesktopDisplayMediaSource['type'],
  fields: Partial<DesktopDisplayMediaSource> = {},
): DesktopDisplayMediaSource {
  return {
    id: `${type}:1`,
    name: type,
    type,
    thumbnailDataUrl: null,
    appIconDataUrl: null,
    ...fields,
  }
}

describe('desktop screen share picker audio contract', () => {
  it('labels source-specific native audio modes', () => {
    expect(sourceAudioLabel(source('screen'))).toBe(
      'Системный звук без приложения',
    )
    expect(sourceAudioLabel(source('game'))).toBe('Звук только игры')
    expect(sourceAudioLabel(source('window'))).toBe('Звук только окна')
  })

  it('does not allow audio for sources without native audio support', () => {
    const unavailableWindow = source('window', {
      audioAvailable: false,
      audioMode: 'none',
    })

    expect(sourceAudioLabel(unavailableWindow)).toBe('Звук недоступен')
    expect(canRequestSourceAudio(unavailableWindow)).toBe(false)
  })
})
