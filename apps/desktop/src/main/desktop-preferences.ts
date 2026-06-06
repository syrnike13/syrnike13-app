import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type DesktopPreferences = {
  closeToTray: boolean
}

export const DEFAULT_DESKTOP_PREFERENCES: DesktopPreferences = {
  closeToTray: true,
}

export function normalizeDesktopPreferences(value: unknown): DesktopPreferences {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_DESKTOP_PREFERENCES }
  }

  const preferences = value as Partial<DesktopPreferences>
  return {
    closeToTray:
      typeof preferences.closeToTray === 'boolean'
        ? preferences.closeToTray
        : DEFAULT_DESKTOP_PREFERENCES.closeToTray,
  }
}

export async function loadDesktopPreferences(filePath: string) {
  try {
    return normalizeDesktopPreferences(
      JSON.parse(await readFile(filePath, 'utf8')),
    )
  } catch {
    return { ...DEFAULT_DESKTOP_PREFERENCES }
  }
}

export async function saveDesktopPreferences(
  filePath: string,
  preferences: DesktopPreferences,
) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(preferences, null, 2)}\n`, 'utf8')
}
