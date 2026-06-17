import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  DEFAULT_DESKTOP_LOCAL_SETTINGS,
  type DesktopLocalSettings,
  type DesktopLocalSettingsPatch,
  normalizeDesktopLocalSettings,
  normalizeDesktopLocalSettingsPatch,
} from '@syrnike13/platform'

export function desktopLocalSettingsDefaults(
  platform: NodeJS.Platform = process.platform,
): DesktopLocalSettings {
  return {
    ...DEFAULT_DESKTOP_LOCAL_SETTINGS,
    voice: {
      ...DEFAULT_DESKTOP_LOCAL_SETTINGS.voice,
      screenShareQuality:
        platform === 'win32'
          ? 'high60'
          : DEFAULT_DESKTOP_LOCAL_SETTINGS.voice.screenShareQuality,
    },
  }
}

export async function loadDesktopLocalSettings(
  filePath: string,
  defaults: DesktopLocalSettings = DEFAULT_DESKTOP_LOCAL_SETTINGS,
): Promise<DesktopLocalSettings> {
  try {
    return normalizeDesktopLocalSettings(
      JSON.parse(await readFile(filePath, 'utf8')),
      defaults,
    )
  } catch {
    return defaults
  }
}

export async function saveDesktopLocalSettings(
  filePath: string,
  settings: DesktopLocalSettings,
) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

export async function updateDesktopLocalSettings(
  filePath: string,
  patch: DesktopLocalSettingsPatch,
  defaults: DesktopLocalSettings = DEFAULT_DESKTOP_LOCAL_SETTINGS,
): Promise<DesktopLocalSettings> {
  const current = await loadDesktopLocalSettings(filePath, defaults)
  const normalizedPatch = normalizeDesktopLocalSettingsPatch(patch)
  const next: DesktopLocalSettings = {
    version: 1,
    voice: {
      ...current.voice,
      ...normalizedPatch.voice,
    },
    voiceListener: {
      ...current.voiceListener,
      ...normalizedPatch.voiceListener,
    },
    overlay: {
      ...current.overlay,
      ...normalizedPatch.overlay,
    },
    appearance: {
      ...current.appearance,
      ...normalizedPatch.appearance,
    },
    sounds: {
      ...current.sounds,
      ...normalizedPatch.sounds,
    },
    easter: {
      ...current.easter,
      ...normalizedPatch.easter,
    },
    music: {
      ...current.music,
      ...normalizedPatch.music,
      providers: {
        spotify: {
          ...current.music.providers.spotify,
          ...normalizedPatch.music?.providers?.spotify,
        },
        apple_music: {
          ...current.music.providers.apple_music,
          ...normalizedPatch.music?.providers?.apple_music,
        },
        yandex_music: {
          ...current.music.providers.yandex_music,
          ...normalizedPatch.music?.providers?.yandex_music,
        },
      },
    },
  }
  await saveDesktopLocalSettings(filePath, next)
  return next
}
