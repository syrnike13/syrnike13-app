// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_DESKTOP_LOCAL_SETTINGS,
  type DesktopLocalSettings,
  type SyrnikeDesktopApi,
} from '@syrnike13/platform'

function installDesktopSettings(settings: DesktopLocalSettings) {
  const update = vi.fn(async () => settings)
  Object.defineProperty(window, 'syrnikeDesktop', {
    configurable: true,
    value: {
      runtime: 'desktop',
      platform: { os: 'win32' },
      settings: {
        load: vi.fn(async () => settings),
        update,
      },
    } satisfies Partial<SyrnikeDesktopApi>,
  })
  return { update }
}

describe('desktop voice settings persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
    Reflect.deleteProperty(window, 'syrnikeDesktop')
  })

  it('hydrates voice processing preferences from the desktop settings API', async () => {
    installDesktopSettings({
      ...DEFAULT_DESKTOP_LOCAL_SETTINGS,
      voice: {
        ...DEFAULT_DESKTOP_LOCAL_SETTINGS.voice,
        noiseSuppression: false,
      },
    })

    const { hydrateVoicePreferencesFromDesktop, voicePreferenceStore } =
      await import('./voice-preference-store')

    await hydrateVoicePreferencesFromDesktop()

    expect(voicePreferenceStore.getState().noiseSuppression).toBe(false)
  })

  it('hydrates per-user listener volume from the desktop settings API', async () => {
    installDesktopSettings({
      ...DEFAULT_DESKTOP_LOCAL_SETTINGS,
      voiceListener: {
        ...DEFAULT_DESKTOP_LOCAL_SETTINGS.voiceListener,
        userVolumes: { userA: 0.25 },
      },
    })

    const { hydrateVoiceListenerSettingsFromDesktop, voiceListenerStore } =
      await import('./voice-listener-store')

    await hydrateVoiceListenerSettingsFromDesktop()

    expect(voiceListenerStore.getUserVolume('userA')).toBe(0.25)
  })
})
