import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  DEFAULT_DESKTOP_OVERLAY_PREFERENCES,
  normalizeDesktopOverlayPreferences,
  type DesktopOverlayPreferences,
} from '@syrnike13/platform'

export type DesktopPreferences = {
  closeToTray: boolean
  openAtLogin: boolean
  overlay: DesktopOverlayPreferences
}

export const DEFAULT_DESKTOP_PREFERENCES: DesktopPreferences = {
  closeToTray: true,
  openAtLogin: true,
  overlay: DEFAULT_DESKTOP_OVERLAY_PREFERENCES,
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
    openAtLogin:
      typeof preferences.openAtLogin === 'boolean'
        ? preferences.openAtLogin
        : DEFAULT_DESKTOP_PREFERENCES.openAtLogin,
    overlay: normalizeDesktopOverlayPreferences(preferences.overlay),
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
