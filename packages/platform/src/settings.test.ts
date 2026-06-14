import { describe, expect, it } from 'vitest'

import {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_DESKTOP_LOCAL_SETTINGS,
  DEFAULT_SOUND_AUTHOR_PACK_ID,
  normalizeDesktopLocalSettings,
  normalizeDesktopLocalSettingsPatch,
} from './settings'

describe('desktop local settings contract', () => {
  it('defaults missing settings to the production defaults', () => {
    expect(normalizeDesktopLocalSettings(undefined)).toEqual(
      DEFAULT_DESKTOP_LOCAL_SETTINGS,
    )
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
          noiseSuppression: false,
          outputVolume: 5,
        },
      }),
    ).toEqual({
      voice: {
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
          easterEnabled: false,
        },
      }).sounds,
    ).toEqual({
      enabled: false,
      authorPackId: DEFAULT_SOUND_AUTHOR_PACK_ID,
      volume: 0.4,
      easterEnabled: false,
    })
  })

  it('normalizes UI sound setting patches', () => {
    expect(
      normalizeDesktopLocalSettingsPatch({
        sounds: {
          authorPackId: 'winter',
          volume: 2,
        },
      }),
    ).toEqual({
      sounds: {
        volume: 1,
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
