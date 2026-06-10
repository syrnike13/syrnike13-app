import { useRef, useSyncExternalStore } from 'react'

import {
  loadDesktopLocalSettings,
  updateDesktopLocalSettings,
} from '#/features/settings/desktop-local-settings-client'
import { getSyrnikeDesktop } from '#/platform/runtime'

const STORAGE_KEY = 'syrnike13-voice-listener'
const DEFAULT_USER_VOLUME = 1
/** 0–3 (до 300% в UI, в браузере cap 100%). */
export const VOICE_USER_VOLUME_MAX = 3

type VoiceListenerState = {
  userVolumes: Record<string, number>
  userMutes: Record<string, boolean>
  streamVolumes: Record<string, number>
  streamMutes: Record<string, boolean>
}

function emptyState(): VoiceListenerState {
  return { userVolumes: {}, userMutes: {}, streamVolumes: {}, streamMutes: {} }
}

function normalizeVoiceListenerState(value: unknown): VoiceListenerState {
  if (!value || typeof value !== 'object') return emptyState()
  const parsed = value as Partial<VoiceListenerState>
  return {
    userVolumes:
      parsed.userVolumes && typeof parsed.userVolumes === 'object'
        ? parsed.userVolumes
        : {},
    userMutes:
      parsed.userMutes && typeof parsed.userMutes === 'object'
        ? parsed.userMutes
        : {},
    streamVolumes:
      parsed.streamVolumes && typeof parsed.streamVolumes === 'object'
        ? parsed.streamVolumes
        : {},
    streamMutes:
      parsed.streamMutes && typeof parsed.streamMutes === 'object'
        ? parsed.streamMutes
        : {},
  }
}

function loadState(): VoiceListenerState {
  if (typeof window === 'undefined' || getSyrnikeDesktop()) return emptyState()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return normalizeVoiceListenerState(raw ? JSON.parse(raw) : null)
  } catch {
    return emptyState()
  }
}

let state = loadState()
let stateRevision = 0
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
}

function persist() {
  if (typeof window === 'undefined') return
  if (getSyrnikeDesktop()) {
    void updateDesktopLocalSettings({ voiceListener: state })
    return
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // quota / private mode
  }
}

function replaceState(next: VoiceListenerState) {
  state = next
  stateRevision += 1
  persist()
  emit()
}

export async function hydrateVoiceListenerSettingsFromDesktop() {
  const revision = stateRevision
  const settings = await loadDesktopLocalSettings()
  if (!settings || revision !== stateRevision) return
  state = normalizeVoiceListenerState(settings.voiceListener)
  emit()
}

export function formatUserVolumeLabel(userVolume: number) {
  return `${Math.round(userVolume * 100)}%`
}

export const voiceListenerStore = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  getState: () => state,

  getUserVolume(userId: string) {
    return state.userVolumes[userId] ?? DEFAULT_USER_VOLUME
  },

  setUserVolume(userId: string, volume: number) {
    const next = Math.min(
      VOICE_USER_VOLUME_MAX,
      Math.max(0, Number(volume.toFixed(2))),
    )
    if (state.userVolumes[userId] === next) return
    replaceState({
      ...state,
      userVolumes: { ...state.userVolumes, [userId]: next },
    })
  },

  getUserMuted(userId: string) {
    return state.userMutes[userId] ?? false
  },

  setUserMuted(userId: string, muted: boolean) {
    if (state.userMutes[userId] === muted) return
    const userMutes = { ...state.userMutes }
    if (muted) {
      userMutes[userId] = true
    } else {
      delete userMutes[userId]
    }
    replaceState({ ...state, userMutes })
  },

  getStreamVolume(userId: string) {
    return state.streamVolumes[userId] ?? DEFAULT_USER_VOLUME
  },

  setStreamVolume(userId: string, volume: number) {
    const next = Math.min(
      VOICE_USER_VOLUME_MAX,
      Math.max(0, Number(volume.toFixed(2))),
    )
    if (state.streamVolumes[userId] === next) return
    replaceState({
      ...state,
      streamVolumes: { ...state.streamVolumes, [userId]: next },
    })
  },

  getStreamMuted(userId: string) {
    return state.streamMutes[userId] ?? false
  },

  setStreamMuted(userId: string, muted: boolean) {
    if (state.streamMutes[userId] === muted) return
    const streamMutes = { ...state.streamMutes }
    if (muted) {
      streamMutes[userId] = true
    } else {
      delete streamMutes[userId]
    }
    replaceState({ ...state, streamMutes })
  },
}

export function useVoiceListenerStore<T>(
  selector: (store: typeof voiceListenerStore) => T,
): T {
  const selectorRef = useRef(selector)
  selectorRef.current = selector
  const cacheRef = useRef<{ state: VoiceListenerState; value: T } | null>(null)

  const getSnapshot = () => {
    const current = voiceListenerStore.getState()
    if (cacheRef.current?.state === current) {
      return cacheRef.current.value
    }
    const value = selectorRef.current(voiceListenerStore)
    cacheRef.current = { state: current, value }
    return value
  }

  return useSyncExternalStore(
    voiceListenerStore.subscribe,
    getSnapshot,
    getSnapshot,
  )
}

void hydrateVoiceListenerSettingsFromDesktop()
