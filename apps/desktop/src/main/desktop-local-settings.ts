import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  DEFAULT_DESKTOP_LOCAL_SETTINGS,
  type DesktopLocalSettings,
  type DesktopLocalSettingsPatch,
  normalizeDesktopLocalSettings,
  normalizeDesktopLocalSettingsPatch,
} from '@syrnike13/platform'

const settingsWriteQueues = new Map<string, Promise<void>>()

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
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown
  } catch {
    return defaults
  }
  if (!isSettingsObject(parsed)) return defaults
  if (isCurrentSettingsVersion(parsed)) {
    return normalizeDesktopLocalSettings(parsed, defaults)
  }

  return serializeSettingsWrite(filePath, async () => {
    let latest: unknown
    try {
      latest = JSON.parse(await readFile(filePath, 'utf8')) as unknown
    } catch {
      return defaults
    }
    if (!isSettingsObject(latest)) return defaults
    const normalized = normalizeDesktopLocalSettings(latest, defaults)
    if (!isCurrentSettingsVersion(latest)) {
      await writeDesktopLocalSettingsAtomically(filePath, normalized)
    }
    return normalized
  })
}

export async function saveDesktopLocalSettings(
  filePath: string,
  settings: DesktopLocalSettings,
) {
  return serializeSettingsWrite(filePath, () =>
    writeDesktopLocalSettingsAtomically(filePath, settings),
  )
}

export async function updateDesktopLocalSettings(
  filePath: string,
  patch: DesktopLocalSettingsPatch,
  defaults: DesktopLocalSettings = DEFAULT_DESKTOP_LOCAL_SETTINGS,
): Promise<DesktopLocalSettings> {
  let result = defaults
  await serializeSettingsWrite(filePath, async () => {
    const current = await readDesktopLocalSettings(filePath, defaults)
    const normalizedPatch = normalizeDesktopLocalSettingsPatch(patch)
    result = {
      version: 3,
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
      observability: {
        ...current.observability,
        ...normalizedPatch.observability,
      },
    }
    await writeDesktopLocalSettingsAtomically(filePath, result)
  })
  return result
}

async function readDesktopLocalSettings(
  filePath: string,
  defaults: DesktopLocalSettings,
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

function isCurrentSettingsVersion(value: unknown) {
  return isSettingsObject(value) && value.version === 3
}

function isSettingsObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

async function serializeSettingsWrite<T>(
  filePath: string,
  write: () => Promise<T>,
): Promise<T> {
  const previous = settingsWriteQueues.get(filePath) ?? Promise.resolve()
  let releaseQueue: () => void = () => {}
  const current = new Promise<void>((resolve) => {
    releaseQueue = resolve
  })
  settingsWriteQueues.set(filePath, current)

  await previous.catch(() => undefined)
  try {
    return await write()
  } finally {
    releaseQueue()
    if (settingsWriteQueues.get(filePath) === current) {
      settingsWriteQueues.delete(filePath)
    }
  }
}

async function writeDesktopLocalSettingsAtomically(
  filePath: string,
  settings: DesktopLocalSettings,
) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.tmp`
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(settings, null, 2)}\n`,
      'utf8',
    )
    await rename(temporaryPath, filePath)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}
