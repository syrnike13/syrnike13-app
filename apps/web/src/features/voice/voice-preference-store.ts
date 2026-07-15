import type {
  ScreenShareCaptureMode,
  ScreenShareCodec,
  ScreenShareQualityName,
} from '#/features/voice/voice-preference-types'
import {
  loadDesktopLocalSettings,
  updateDesktopLocalSettings,
} from '#/features/settings/desktop-local-settings-client'
import {
  DEFAULT_VOICE_GATE_THRESHOLD_DB,
  linearThresholdToDb,
  normalizeVoiceGateThresholdDb,
} from '#/features/voice/voice-gate-level'
import { getSyrnikeDesktop } from '#/platform/runtime'

const STORAGE_KEY = 'syrnike13-voice-preferences'
const STORAGE_VERSION = 2

export const VOICE_OUTPUT_VOLUME_MAX = 3

export type VoicePreferenceState = {
  micEnabled: boolean
  deafened: boolean
  preferredAudioInputDevice?: string
  preferredAudioOutputDevice?: string
  preferredVideoDevice?: string
  inputVolume: number
  outputVolume: number
  bypassSystemAudioInputProcessing: boolean
  automaticGainControl: boolean
  noiseSuppression: boolean
  echoCancellation: boolean
  voiceGateEnabled: boolean
  voiceGateThresholdDb: number
  voiceGateAutoThreshold: boolean
  screenShareQuality: ScreenShareQualityName
  screenShareCodec: ScreenShareCodec
  screenShareAudio: boolean
  screenShareCaptureMode: ScreenShareCaptureMode
}

export type VoiceJoinPreferences = Pick<
  VoicePreferenceState,
  'micEnabled' | 'deafened'
>

export function defaultScreenShareQuality(): ScreenShareQualityName {
  if (
    typeof window !== 'undefined' &&
    window.syrnikeDesktop?.platform.os === 'win32'
  ) {
    return 'high60'
  }
  return 'low'
}

const DEFAULT_STATE: VoicePreferenceState = {
  micEnabled: true,
  deafened: false,
  inputVolume: 1,
  outputVolume: 1,
  bypassSystemAudioInputProcessing: true,
  automaticGainControl: true,
  noiseSuppression: true,
  echoCancellation: false,
  voiceGateEnabled: true,
  voiceGateThresholdDb: DEFAULT_VOICE_GATE_THRESHOLD_DB,
  voiceGateAutoThreshold: true,
  screenShareQuality: defaultScreenShareQuality(),
  screenShareCodec: 'auto',
  screenShareAudio: true,
  screenShareCaptureMode: 'auto',
}

export function effectiveVoiceJoinPreferences(
  preferences: VoiceJoinPreferences,
): VoiceJoinPreferences {
  return {
    micEnabled: preferences.deafened ? false : preferences.micEnabled,
    deafened: preferences.deafened,
  }
}

function parseScreenShareQuality(value: unknown): ScreenShareQualityName {
  if (
    value === 'low' ||
    value === 'high' ||
    value === 'high60' ||
    value === 'text'
  ) {
    return value
  }
  return defaultScreenShareQuality()
}

function parseScreenShareCodec(value: unknown): ScreenShareCodec {
  if (value === 'av1') return 'av1'
  return DEFAULT_STATE.screenShareCodec
}

export function parseScreenShareCaptureMode(value: unknown): ScreenShareCaptureMode {
  if (value === 'native' || value === 'auto') {
    return value
  }
  return DEFAULT_STATE.screenShareCaptureMode
}

function parseVoiceGateThresholdDb(parsed: Record<string, unknown>) {
  if (typeof parsed.voiceGateThresholdDb === 'number') {
    return normalizeVoiceGateThresholdDb(parsed.voiceGateThresholdDb)
  }
  if (typeof parsed.voiceGateThreshold === 'number') {
    return linearThresholdToDb(parsed.voiceGateThreshold)
  }
  return DEFAULT_STATE.voiceGateThresholdDb
}

export function normalizeVoicePreferenceState(
  parsed: Partial<VoicePreferenceState> | null | undefined,
): VoicePreferenceState {
  if (!parsed) {
    return {
      ...DEFAULT_STATE,
      screenShareQuality: defaultScreenShareQuality(),
    }
  }

  return {
    micEnabled:
      typeof parsed.micEnabled === 'boolean'
        ? parsed.micEnabled
        : DEFAULT_STATE.micEnabled,
    deafened:
      typeof parsed.deafened === 'boolean'
        ? parsed.deafened
        : DEFAULT_STATE.deafened,
    preferredAudioInputDevice:
      typeof parsed.preferredAudioInputDevice === 'string'
        ? parsed.preferredAudioInputDevice
        : undefined,
    preferredAudioOutputDevice:
      typeof parsed.preferredAudioOutputDevice === 'string'
        ? parsed.preferredAudioOutputDevice
        : undefined,
    preferredVideoDevice:
      typeof parsed.preferredVideoDevice === 'string'
        ? parsed.preferredVideoDevice
        : undefined,
    inputVolume:
      typeof parsed.inputVolume === 'number' &&
      parsed.inputVolume >= 0 &&
      parsed.inputVolume <= VOICE_OUTPUT_VOLUME_MAX
        ? parsed.inputVolume
        : DEFAULT_STATE.inputVolume,
    outputVolume:
      typeof parsed.outputVolume === 'number' &&
      parsed.outputVolume >= 0 &&
      parsed.outputVolume <= VOICE_OUTPUT_VOLUME_MAX
        ? parsed.outputVolume
        : DEFAULT_STATE.outputVolume,
    bypassSystemAudioInputProcessing:
      typeof parsed.bypassSystemAudioInputProcessing === 'boolean'
        ? parsed.bypassSystemAudioInputProcessing
        : DEFAULT_STATE.bypassSystemAudioInputProcessing,
    automaticGainControl:
      typeof parsed.automaticGainControl === 'boolean'
        ? parsed.automaticGainControl
        : DEFAULT_STATE.automaticGainControl,
    noiseSuppression:
      typeof parsed.noiseSuppression === 'boolean'
        ? parsed.noiseSuppression
        : DEFAULT_STATE.noiseSuppression,
    echoCancellation:
      typeof parsed.echoCancellation === 'boolean'
        ? parsed.echoCancellation
        : DEFAULT_STATE.echoCancellation,
    voiceGateEnabled:
      typeof parsed.voiceGateEnabled === 'boolean'
        ? parsed.voiceGateEnabled
        : DEFAULT_STATE.voiceGateEnabled,
    voiceGateThresholdDb: parseVoiceGateThresholdDb(parsed),
    voiceGateAutoThreshold:
      typeof parsed.voiceGateAutoThreshold === 'boolean'
        ? parsed.voiceGateAutoThreshold
        : DEFAULT_STATE.voiceGateAutoThreshold,
    screenShareQuality: parseScreenShareQuality(parsed.screenShareQuality),
    screenShareCodec: parseScreenShareCodec(parsed.screenShareCodec),
    screenShareAudio:
      typeof parsed.screenShareAudio === 'boolean'
        ? parsed.screenShareAudio
        : DEFAULT_STATE.screenShareAudio,
    screenShareCaptureMode: parseScreenShareCaptureMode(
      parsed.screenShareCaptureMode,
    ),
  }
}

type PersistedVoicePreferenceState = Partial<VoicePreferenceState> & {
  version?: unknown
}

export function loadVoicePreferenceState(): VoicePreferenceState {
  if (typeof window === 'undefined' || getSyrnikeDesktop()) {
    return normalizeVoicePreferenceState(null)
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return normalizeVoicePreferenceState(null)
    const parsed = JSON.parse(raw) as PersistedVoicePreferenceState
    const normalized = normalizeVoicePreferenceState(parsed)
    if (parsed.version !== STORAGE_VERSION) {
      normalized.echoCancellation = false
      normalized.automaticGainControl = true
      try {
        persistBrowserState(normalized)
      } catch {
        // quota / private mode
      }
    }
    return normalized
  } catch {
    return normalizeVoicePreferenceState(null)
  }
}

let state = loadVoicePreferenceState()
let stateRevision = 0
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
}

function persist() {
  if (typeof window === 'undefined') return
  if (getSyrnikeDesktop()) {
    void updateDesktopLocalSettings({ voice: state })
    return
  }
  try {
    persistBrowserState(state)
  } catch {
    // quota / private mode
  }
}

function persistBrowserState(nextState: VoicePreferenceState) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ version: STORAGE_VERSION, ...nextState }),
  )
}

function patch(partial: Partial<VoicePreferenceState>) {
  state = { ...state, ...partial }
  stateRevision += 1
  persist()
  emit()
}

export async function hydrateVoicePreferencesFromDesktop() {
  const revision = stateRevision
  const settings = await loadDesktopLocalSettings()
  if (!settings || revision !== stateRevision) return
  state = normalizeVoicePreferenceState(settings.voice)
  emit()
}

export const voicePreferenceStore = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  getState: () => state,

  getMicEnabled: () => state.micEnabled,
  getDeafened: () => state.deafened,
  getInputVolume: () => state.inputVolume,
  getOutputVolume: () => state.outputVolume,
  getBypassSystemAudioInputProcessing: () =>
    state.bypassSystemAudioInputProcessing,
  getAutomaticGainControl: () => state.automaticGainControl,
  getNoiseSuppression: () => state.noiseSuppression,
  getPreferredAudioInputDevice: () => state.preferredAudioInputDevice,
  getPreferredAudioOutputDevice: () => state.preferredAudioOutputDevice,
  getPreferredVideoDevice: () => state.preferredVideoDevice,

  setMicEnabled: (micEnabled: boolean) => {
    if (state.micEnabled === micEnabled) return
    patch({ micEnabled })
  },
  setDeafened: (deafened: boolean) => {
    if (state.deafened === deafened) return
    patch({ deafened })
  },
  setInputVolume: (inputVolume: number) => {
    const next = Math.min(
      VOICE_OUTPUT_VOLUME_MAX,
      Math.max(0, Number(inputVolume.toFixed(2))),
    )
    if (state.inputVolume === next) return
    patch({ inputVolume: next })
  },
  setOutputVolume: (outputVolume: number) => {
    const next = Math.min(
      VOICE_OUTPUT_VOLUME_MAX,
      Math.max(0, Number(outputVolume.toFixed(2))),
    )
    if (state.outputVolume === next) return
    patch({ outputVolume: next })
  },
  setBypassSystemAudioInputProcessing: (
    bypassSystemAudioInputProcessing: boolean,
  ) => {
    if (
      state.bypassSystemAudioInputProcessing ===
      bypassSystemAudioInputProcessing
    ) return
    patch({ bypassSystemAudioInputProcessing })
  },
  setAutomaticGainControl: (automaticGainControl: boolean) => {
    if (state.automaticGainControl === automaticGainControl) return
    patch({ automaticGainControl })
  },
  setNoiseSuppression: (noiseSuppression: boolean) => {
    if (state.noiseSuppression === noiseSuppression) return
    patch({ noiseSuppression })
  },
  setPreferredAudioInputDevice: (deviceId: string | undefined) => {
    if (state.preferredAudioInputDevice === deviceId) return
    patch({ preferredAudioInputDevice: deviceId })
  },
  setPreferredAudioOutputDevice: (deviceId: string | undefined) => {
    if (state.preferredAudioOutputDevice === deviceId) return
    patch({ preferredAudioOutputDevice: deviceId })
  },
  setPreferredVideoDevice: (deviceId: string | undefined) => {
    if (state.preferredVideoDevice === deviceId) return
    patch({ preferredVideoDevice: deviceId })
  },
  setEchoCancellation: (echoCancellation: boolean) => {
    if (state.echoCancellation === echoCancellation) return
    patch({ echoCancellation })
  },
  setVoiceGateEnabled: (voiceGateEnabled: boolean) => {
    if (state.voiceGateEnabled === voiceGateEnabled) return
    patch({ voiceGateEnabled })
  },
  setVoiceGateThresholdDb: (voiceGateThresholdDb: number) => {
    const next = normalizeVoiceGateThresholdDb(voiceGateThresholdDb)
    if (state.voiceGateThresholdDb === next && !state.voiceGateAutoThreshold) {
      return
    }
    patch({ voiceGateThresholdDb: next, voiceGateAutoThreshold: false })
  },
  setVoiceGateAutoThreshold: (voiceGateAutoThreshold: boolean) => {
    if (state.voiceGateAutoThreshold === voiceGateAutoThreshold) return
    patch({ voiceGateAutoThreshold })
  },
  setScreenShareQuality: (screenShareQuality: ScreenShareQualityName) => {
    if (state.screenShareQuality === screenShareQuality) return
    patch({ screenShareQuality })
  },
  setScreenShareCodec: (screenShareCodec: ScreenShareCodec) => {
    if (state.screenShareCodec === screenShareCodec) return
    patch({ screenShareCodec })
  },
  setScreenShareAudio: (screenShareAudio: boolean) => {
    if (state.screenShareAudio === screenShareAudio) return
    patch({ screenShareAudio })
  },
  setScreenShareCaptureMode: (screenShareCaptureMode: ScreenShareCaptureMode) => {
    if (state.screenShareCaptureMode === screenShareCaptureMode) return
    patch({ screenShareCaptureMode })
  },
}

export function readVoicePreferences() {
  return voicePreferenceStore.getState()
}

void hydrateVoicePreferencesFromDesktop()
