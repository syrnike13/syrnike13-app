import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_DESKTOP_LOCAL_SETTINGS,
  type DesktopLocalSettings,
} from '@syrnike13/platform'

import {
  desktopLocalSettingsDefaults,
  loadDesktopLocalSettings,
  updateDesktopLocalSettings,
} from './desktop-local-settings'

describe('desktop local settings', () => {
  it('loads defaults when the settings file does not exist', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'syrnike-settings-'))
    const filePath = path.join(dir, 'local-settings.json')

    try {
      await expect(loadDesktopLocalSettings(filePath)).resolves.toEqual(
        DEFAULT_DESKTOP_LOCAL_SETTINGS,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps the Windows desktop screen-share quality default', () => {
    expect(desktopLocalSettingsDefaults('win32').voice.screenShareQuality).toBe(
      'high60',
    )
  })

  it('merges partial updates into the persisted settings file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'syrnike-settings-'))
    const filePath = path.join(dir, 'local-settings.json')

    try {
      const next = await updateDesktopLocalSettings(filePath, {
        voice: {
          noiseSuppression: false,
          preferredAudioInputDevice: 'mic-1',
        },
        voiceListener: {
          userVolumes: { userA: 0.25 },
        },
      })

      expect(next).toMatchObject({
        voice: {
          noiseSuppression: false,
          preferredAudioInputDevice: 'mic-1',
        },
        voiceListener: {
          userVolumes: { userA: 0.25 },
        },
      })

      const saved = JSON.parse(await readFile(filePath, 'utf8')) as DesktopLocalSettings
      expect(saved).toEqual(next)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('merges overlay updates into the persisted settings file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'syrnike-settings-'))
    const filePath = path.join(dir, 'local-settings.json')

    try {
      const next = await updateDesktopLocalSettings(filePath, {
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

      expect(next.overlay).toEqual({
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
      })

      const saved = JSON.parse(await readFile(filePath, 'utf8')) as DesktopLocalSettings
      expect(saved).toEqual(next)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('merges music integration updates into the persisted settings file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'syrnike-settings-'))
    const filePath = path.join(dir, 'local-settings.json')

    try {
      const next = await updateDesktopLocalSettings(filePath, {
        music: {
          enabled: true,
          showInProfile: false,
          providers: {
            spotify: {
              enabled: true,
              source: 'spotify_api',
            },
            apple_music: {
              enabled: true,
              source: 'desktop_now_playing',
            },
          },
        },
      })

      expect(next.music).toMatchObject({
        enabled: true,
        showInProfile: false,
        providers: {
          spotify: {
            enabled: true,
            source: 'spotify_api',
          },
          apple_music: {
            enabled: true,
            source: 'desktop_now_playing',
          },
          yandex_music: DEFAULT_DESKTOP_LOCAL_SETTINGS.music.providers.yandex_music,
        },
      })

      const saved = JSON.parse(await readFile(filePath, 'utf8')) as DesktopLocalSettings
      expect(saved).toEqual(next)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('merges easter mode updates into the persisted settings file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'syrnike-settings-'))
    const filePath = path.join(dir, 'local-settings.json')

    try {
      const next = await updateDesktopLocalSettings(filePath, {
        easter: {
          enabled: true,
        },
      })

      expect(next.easter).toEqual({
        enabled: true,
      })

      const saved = JSON.parse(await readFile(filePath, 'utf8')) as DesktopLocalSettings
      expect(saved).toEqual(next)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
