import { describe, expect, it } from 'vitest'

import { desktopDownload } from './config'

describe('desktopDownload', () => {
  it('points at the Windows installer', () => {
    expect(desktopDownload.label).toBe('Windows')
    expect(desktopDownload.url).toBe(
      'https://syrnike13.ru/downloads/syrnike13-setup.exe',
    )
  })
})
