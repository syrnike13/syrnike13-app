import { describe, expect, it } from 'vitest'

import {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_DESKTOP_LOCAL_SETTINGS,
  DEFAULT_DESKTOP_OBSERVABILITY_SETTINGS,
  DEFAULT_SOUND_AUTHOR_PACK_ID,
  normalizeAppearanceGradientSettings,
  normalizeDesktopLocalSettings,
  normalizeDesktopLocalSettingsPatch,
} from './settings'

describe('desktop local settings contract', () => {
  it('defaults missing settings to the production defaults', () => {
    expect(normalizeDesktopLocalSettings(undefined)).toEqual(
      DEFAULT_DESKTOP_LOCAL_SETTINGS,
    )
  })

  it('migrates legacy microphone defaults without changing other settings', () => {
    expect(
      normalizeDesktopLocalSettings({
        version: 1,
        voice: {
          preferredAudioInputDevice: 'legacy-mic',
          inputVolume: 0.42,
          noiseSuppression: false,
          echoCancellation: true,
          automaticGainControl: false,
        },
        appearance: { themeId: 'night' },
      }),
    ).toMatchObject({
      version: 3,
      voice: {
        preferredAudioInputDevice: 'legacy-mic',
        inputVolume: 0.42,
        noiseSuppression: false,
        echoCancellation: false,
        automaticGainControl: true,
      },
      appearance: { themeId: 'night' },
    })
  })

  it('preserves explicit microphone processing values after migration', () => {
    expect(
      normalizeDesktopLocalSettings({
        version: 2,
        voice: {
          echoCancellation: true,
          automaticGainControl: false,
        },
      }).voice,
    ).toMatchObject({
      echoCancellation: true,
      automaticGainControl: false,
    })
  })

  it('keeps saved voice and listener settings', () => {
    expect(
      normalizeDesktopLocalSettings({
        voice: {
          micEnabled: false,
          deafened: true,
          preferredAudioInputDevice: 'mic-1',
          preferredAudioOutputDevice: 'speaker-1',
          preferredVideoDevice: 'camera-1',
          inputVolume: 0.42,
          outputVolume: 1.7,
          bypassSystemAudioInputProcessing: false,
          automaticGainControl: true,
          noiseSuppression: false,
          echoCancellation: false,
          voiceGateEnabled: true,
          voiceGateThresholdDb: -18,
          voiceGateAutoThreshold: false,
          screenShareQuality: 'high60',
          screenShareCodec: 'av1',
          screenShareAudio: false,
          screenShareCaptureMode: 'native',
        },
        voiceListener: {
          userVolumes: { userA: 0.35 },
          userMutes: { userB: true },
          streamVolumes: { userC: 1.45 },
          streamMutes: { userD: true },
        },
      }),
    ).toMatchObject({
      voice: {
        micEnabled: false,
        deafened: true,
        preferredAudioInputDevice: 'mic-1',
        outputVolume: 1.7,
        bypassSystemAudioInputProcessing: false,
        automaticGainControl: true,
        noiseSuppression: false,
        screenShareQuality: 'high60',
      },
      voiceListener: {
        userVolumes: { userA: 0.35 },
        userMutes: { userB: true },
        streamVolumes: { userC: 1.45 },
        streamMutes: { userD: true },
      },
    })
  })

  it('keeps saved overlay settings with per-game toggles', () => {
    expect(
      normalizeDesktopLocalSettings({
        overlay: {
          enabled: false,
          games: [
            {
              id: 'c:/games/raid.exe',
              processName: 'raid.exe',
              processPath: 'C:/Games/Raid.exe',
              title: 'Raid',
              enabled: false,
              lastSeenAt: 123,
            },
            {
              id: '',
              processName: '',
              processPath: null,
              title: 42,
              enabled: true,
              lastSeenAt: 'now',
            },
          ],
        },
      }),
    ).toMatchObject({
      overlay: {
        enabled: false,
        games: [
          {
            id: 'c:/games/raid.exe',
            processName: 'raid.exe',
            processPath: 'C:/Games/Raid.exe',
            title: 'Raid',
            enabled: false,
            lastSeenAt: 123,
          },
        ],
      },
    })
  })

  it('normalizes patches without filling unrelated namespaces', () => {
    expect(
      normalizeDesktopLocalSettingsPatch({
        voice: {
          bypassSystemAudioInputProcessing: false,
          automaticGainControl: true,
          noiseSuppression: false,
          outputVolume: 5,
        },
      }),
    ).toEqual({
      voice: {
        bypassSystemAudioInputProcessing: false,
        automaticGainControl: true,
        noiseSuppression: false,
        outputVolume: 3,
      },
    })
  })

  it('keeps saved UI sound settings', () => {
    expect(
      normalizeDesktopLocalSettings({
        sounds: {
          enabled: false,
          authorPackId: DEFAULT_SOUND_AUTHOR_PACK_ID,
          volume: 0.4,
          eventVolumes: {
            'voice.mute': 0.25,
            'voice.unmute': 2,
            broken: 'nope',
          },
          easterEnabled: false,
        },
      }).sounds,
    ).toEqual({
      enabled: false,
      authorPackId: DEFAULT_SOUND_AUTHOR_PACK_ID,
      volume: 0.4,
      eventVolumes: {
        'voice.mute': 0.25,
        'voice.unmute': 1,
      },
      easterEnabled: false,
    })
  })

  it('normalizes UI sound setting patches', () => {
    expect(
      normalizeDesktopLocalSettingsPatch({
        sounds: {
          authorPackId: 'winter',
          volume: 2,
          eventVolumes: {
            'voice.mute': -1,
            'voice.unmute': 0.35,
            broken: Number.NaN,
          },
        },
      }),
    ).toEqual({
      sounds: {
        volume: 1,
        eventVolumes: {
          'voice.mute': 0,
          'voice.unmute': 0.35,
        },
      },
    })
  })

  it('defaults native metrics and redacted diagnostic reports on', () => {
    expect(normalizeDesktopLocalSettings({}).observability).toEqual(
      DEFAULT_DESKTOP_OBSERVABILITY_SETTINGS,
    )
  })

  it('enables diagnostic reports for version 2 and preserves a version 3 opt-out', () => {
    expect(
      normalizeDesktopLocalSettings({
        version: 2,
        observability: { diagnosticReports: false },
      }).observability.diagnosticReports,
    ).toBe(true)
    expect(
      normalizeDesktopLocalSettings({
        version: 3,
        observability: { diagnosticReports: false },
      }).observability.diagnosticReports,
    ).toBe(false)
  })

  it('accepts only boolean observability settings', () => {
    expect(
      normalizeDesktopLocalSettingsPatch({
        observability: {
          anonymousNativeMetrics: false,
          diagnosticReports: true,
          nativeCrashReports: true,
          roomUrl: 'wss://private.example',
        },
      }),
    ).toEqual({
      observability: {
        anonymousNativeMetrics: false,
        diagnosticReports: true,
        nativeCrashReports: true,
      },
    })
  })

  it('normalizes overlay patches without filling unrelated namespaces', () => {
    expect(
      normalizeDesktopLocalSettingsPatch({
        overlay: {
          enabled: false,
          games: [
            {
              id: 'c:/games/raid.exe',
              processName: 'raid.exe',
              processPath: 'C:/Games/Raid.exe',
              title: 'Raid',
              enabled: true,
              lastSeenAt: 123,
            },
          ],
        },
      }),
    ).toEqual({
      overlay: {
        enabled: false,
        games: [
          {
            id: 'c:/games/raid.exe',
            processName: 'raid.exe',
            processPath: 'C:/Games/Raid.exe',
            title: 'Raid',
            enabled: true,
            lastSeenAt: 123,
          },
        ],
      },
    })
  })

  it('fills missing appearance settings with defaults', () => {
    expect(
      normalizeDesktopLocalSettings({
        appearance: {},
      }).appearance,
    ).toEqual(DEFAULT_APPEARANCE_SETTINGS)
  })

  it('normalizes custom appearance gradients', () => {
    expect(
      normalizeAppearanceGradientSettings({
        colors: ['#5865f2', ' #f4f4f5 ', 'invalid'],
        angle: 999,
        saturation: -10,
      }),
    ).toEqual({
      colors: ['#5865F2', '#F4F4F5'],
      angle: 360,
      saturation: 0,
    })
  })

  it('keeps valid gradient patches and ignores malformed ones', () => {
    expect(
      normalizeDesktopLocalSettingsPatch({
        appearance: {
          gradient: {
            colors: ['#112233', '#AABBCC'],
            angle: 45,
            saturation: 80,
          },
        },
      }),
    ).toEqual({
      appearance: {
        gradient: {
          colors: ['#112233', '#AABBCC'],
          angle: 45,
          saturation: 80,
        },
      },
    })

    expect(
      normalizeDesktopLocalSettingsPatch({
        appearance: { gradient: { colors: ['nope'] } },
      }),
    ).toEqual({})
  })

  it('ignores malformed non-empty overlay games patches', () => {
    expect(
      normalizeDesktopLocalSettingsPatch({
        overlay: {
          games: [
            {
              id: '',
              processName: '',
              title: 42,
              enabled: true,
              lastSeenAt: 'now',
            },
          ],
        },
      }),
    ).toEqual({})
  })
})
