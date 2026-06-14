import { describe, expect, it } from 'vitest'

import {
  DESKTOP_APP_USER_MODEL_ID,
  desktopWindowIconAssetName,
} from './desktop-app-identity'

describe('desktop app identity', () => {
  it('uses a Windows ico file for native window identity', () => {
    expect(desktopWindowIconAssetName('win32')).toBe('app.ico')
  })

  it('keeps the png logo for non-Windows windows', () => {
    expect(desktopWindowIconAssetName('darwin')).toBe('app-logo.png')
    expect(desktopWindowIconAssetName('linux')).toBe('app-logo.png')
  })

  it('uses the packaged app id as the Windows AppUserModelID', () => {
    expect(DESKTOP_APP_USER_MODEL_ID).toBe('ru.syrnike13.desktop')
  })
})
