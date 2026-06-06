import { useRef, useSyncExternalStore } from 'react'

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

function loadState(): VoiceListenerState {
  if (typeof window === 'undefined') return emptyState()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyState()
    const parsed = JSON.parse(raw) as Partial<VoiceListenerState>
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
  } catch {
    return emptyState()
  }
}

let state = loadState()
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
}

function persist() {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // quota / private mode
  }
}

export function effectiveElementVolume(userVolume: number) {
  return Math.min(1, Math.max(0, userVolume))
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
    state = {
      ...state,
      userVolumes: { ...state.userVolumes, [userId]: next },
    }
    persist()
    emit()
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
    state = { ...state, userMutes }
    persist()
    emit()
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
    state = {
      ...state,
      streamVolumes: { ...state.streamVolumes, [userId]: next },
    }
    persist()
    emit()
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
    state = { ...state, streamMutes }
    persist()
    emit()
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
