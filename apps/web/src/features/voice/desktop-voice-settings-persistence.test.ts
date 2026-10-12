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
    const { update } = installDesktopSettings({
      ...DEFAULT_DESKTOP_LOCAL_SETTINGS,
      voice: {
        ...DEFAULT_DESKTOP_LOCAL_SETTINGS.voice,
        noiseSuppression: false,
        cameraProfile: 'hd1080p30',
        nativeScreenShareProfile: '1080p60',
      },
    })

    const { hydrateVoicePreferencesFromDesktop, voicePreferenceStore } =
      await import('./voice-preference-store')

    await hydrateVoicePreferencesFromDesktop()

    expect(voicePreferenceStore.getState().noiseSuppression).toBe(false)
    expect(voicePreferenceStore.getCameraProfile()).toBe('hd1080p30')
    expect(voicePreferenceStore.getState().nativeScreenShareProfile).toBe('1080p60')
    voicePreferenceStore.setCameraProfile('hd720p30')
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith({
        voice: expect.objectContaining({ cameraProfile: 'hd720p30' }),
      })
    })
    voicePreferenceStore.setNativeScreenShareProfile('720p60')
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith({
        voice: expect.objectContaining({ nativeScreenShareProfile: '720p60' }),
      })
    })
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
