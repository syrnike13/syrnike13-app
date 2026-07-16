import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

  it('persists observability opt-in without changing privacy defaults', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'syrnike-settings-'))
    const filePath = path.join(dir, 'local-settings.json')

    try {
      const next = await updateDesktopLocalSettings(filePath, {
        observability: { nativeCrashReports: true },
      })

      expect(next.observability).toEqual({
        anonymousNativeMetrics: true,
        nativeCrashReports: true,
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('migrates legacy microphone defaults once and persists version 2', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'syrnike-settings-'))
    const filePath = path.join(dir, 'local-settings.json')

    try {
      await writeFile(
        filePath,
        JSON.stringify({
          version: 1,
          voice: {
            preferredAudioInputDevice: 'legacy-mic',
            inputVolume: 0.42,
            echoCancellation: true,
            automaticGainControl: false,
          },
          appearance: { themeId: 'night' },
        }),
      )

      const migrated = await loadDesktopLocalSettings(filePath)
      expect(migrated).toMatchObject({
        version: 2,
        voice: {
          preferredAudioInputDevice: 'legacy-mic',
          inputVolume: 0.42,
          echoCancellation: false,
          automaticGainControl: true,
        },
        appearance: { themeId: 'night' },
      })
      expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(migrated)

      const updated = await updateDesktopLocalSettings(filePath, {
        voice: { echoCancellation: true, automaticGainControl: false },
      })
      await expect(loadDesktopLocalSettings(filePath)).resolves.toEqual(updated)
      expect(updated).toMatchObject({
        version: 2,
        voice: { echoCancellation: true, automaticGainControl: false },
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('serializes concurrent read-modify-write updates without losing fields', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'syrnike-settings-'))
    const filePath = path.join(dir, 'local-settings.json')

    try {
      await Promise.all([
        updateDesktopLocalSettings(filePath, {
          voice: { noiseSuppression: false },
        }),
        updateDesktopLocalSettings(filePath, {
          appearance: { themeId: 'night' },
        }),
      ])

      const saved = JSON.parse(
        await readFile(filePath, 'utf8'),
      ) as DesktopLocalSettings
      expect(saved.voice.noiseSuppression).toBe(false)
      expect(saved.appearance.themeId).toBe('night')
      await expect(access(`${filePath}.tmp`)).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
