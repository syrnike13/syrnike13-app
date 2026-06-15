import { useSyncExternalStore } from 'react'
import {
  DEFAULT_DESKTOP_EASTER_SETTINGS,
  normalizeDesktopEasterSettings,
  type DesktopEasterSettings,
} from '@syrnike13/platform'

import {
  loadDesktopLocalSettings,
  updateDesktopLocalSettings,
} from '#/features/settings/desktop-local-settings-client'
import { getSyrnikeDesktop } from '#/platform/runtime'

export const EASTER_MODE_STORAGE_KEY = 'syrnike13-easter-mode'

function readBrowserCache(): DesktopEasterSettings {
  if (typeof window === 'undefined') return { ...DEFAULT_DESKTOP_EASTER_SETTINGS }

  try {
    const raw = localStorage.getItem(EASTER_MODE_STORAGE_KEY)
    return normalizeDesktopEasterSettings(raw ? JSON.parse(raw) : null)
  } catch {
    return { ...DEFAULT_DESKTOP_EASTER_SETTINGS }
  }
}

function writeBrowserCache(settings: DesktopEasterSettings) {
  if (typeof window === 'undefined') return

  try {
    localStorage.setItem(EASTER_MODE_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // localStorage may be unavailable in private/browser-restricted contexts.
  }
}

let state = readBrowserCache()
let stateRevision = 0
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
}

function persist() {
  writeBrowserCache(state)

  if (getSyrnikeDesktop()) {
    void updateDesktopLocalSettings({ easter: state })
  }
}

function setState(next: DesktopEasterSettings) {
  if (state.enabled === next.enabled) return

  state = next
  stateRevision += 1
  persist()
  emit()
}

export async function hydrateEasterModeFromDesktop() {
  const revision = stateRevision
  const settings = await loadDesktopLocalSettings()
  if (!settings || revision !== stateRevision) return

  state = normalizeDesktopEasterSettings(settings.easter)
  writeBrowserCache(state)
  emit()
}

export const easterModeStore = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  getState: () => state.enabled,

  setEnabled(enabled: boolean) {
    setState(normalizeDesktopEasterSettings({ enabled }))
  },
}

export function useEasterMode() {
  return useSyncExternalStore(
    easterModeStore.subscribe,
    () => easterModeStore.getState(),
    () => easterModeStore.getState(),
  )
}

if (typeof window !== 'undefined') {
  void hydrateEasterModeFromDesktop()
}
