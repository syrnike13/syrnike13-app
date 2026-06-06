import { describe, expect, it } from 'vitest'

import {
  displayMediaSourceTypeFromId,
  isAllowedMediaOrigin,
  shouldGrantDesktopMediaPermission,
} from './media-permissions'

describe('desktop media permissions', () => {
  it('grants media only to the app origin', () => {
    const appUrl = 'http://127.0.0.1:31415'

    expect(
      shouldGrantDesktopMediaPermission(
        appUrl,
        'media',
        'http://127.0.0.1:31415/app',
      ),
    ).toBe(true)
    expect(
      shouldGrantDesktopMediaPermission(
        appUrl,
        'media',
        'https://syrnike13.ru/app',
      ),
    ).toBe(false)
    expect(
      shouldGrantDesktopMediaPermission(
        appUrl,
        'notifications',
        'http://127.0.0.1:31415/app',
      ),
    ).toBe(false)
  })

  it('rejects malformed media origins', () => {
    expect(isAllowedMediaOrigin('http://127.0.0.1:3000', 'not a url')).toBe(
      false,
    )
  })

  it('maps desktop capturer ids to picker source types', () => {
    expect(displayMediaSourceTypeFromId('screen:0:0')).toBe('screen')
    expect(displayMediaSourceTypeFromId('window:12:0')).toBe('window')
  })
})
