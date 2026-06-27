import { describe, expect, it } from 'vitest'

import {
  DESKTOP_APP_USER_MODEL_ID,
  desktopReleaseMetadata,
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

  it('keeps stable release metadata isolated from nightly', () => {
    expect(desktopReleaseMetadata('stable')).toEqual({
      appId: 'ru.syrnike13.desktop',
      autoUpdateEnabled: true,
      displayName: 'syrnike13',
      protocolScheme: 'syrnike13',
      publicHost: 'syrnike13.ru',
    })
  })

  it('uses a separate app identity for nightly releases', () => {
    expect(desktopReleaseMetadata('nightly')).toEqual({
      appId: 'ru.syrnike13.desktop.nightly',
      autoUpdateEnabled: false,
      displayName: 'syrnike13 Nightly',
      protocolScheme: 'syrnike13-nightly',
      publicHost: 'beta.syrnike13.ru',
    })
  })
})
