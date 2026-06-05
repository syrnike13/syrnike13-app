import type {
  NoiseSuppressionMode,
  ScreenShareCodec,
  ScreenShareQualityName,
} from '#/features/voice/voice-preference-types'

const STORAGE_KEY = 'syrnike13-voice-preferences'

export const VOICE_OUTPUT_VOLUME_MAX = 3

export type VoicePreferenceState = {
  micEnabled: boolean
  deafened: boolean
  preferredAudioInputDevice?: string
  preferredAudioOutputDevice?: string
  preferredVideoDevice?: string
  outputVolume: number
  echoCancellation: boolean
  noiseSuppression: NoiseSuppressionMode
  autoGainControl: boolean
  voiceGateEnabled: boolean
  voiceGateThreshold: number
  autoBalanceEnabled: boolean
  autoBalanceStrength: number
  screenShareQuality: ScreenShareQualityName
  screenShareCodec: ScreenShareCodec
  screenShareQualityAsk: boolean
  screenShareAudio: boolean
}

export type VoiceJoinPreferences = Pick<
  VoicePreferenceState,
  'micEnabled' | 'deafened'
>

const DEFAULT_STATE: VoicePreferenceState = {
  micEnabled: true,
  deafened: false,
  outputVolume: 1,
  echoCancellation: true,
  noiseSuppression: 'browser',
  autoGainControl: true,
  voiceGateEnabled: false,
  voiceGateThreshold: 0.04,
  autoBalanceEnabled: false,
  autoBalanceStrength: 0.5,
  screenShareQuality: 'low',
  screenShareCodec: 'auto',
  screenShareQualityAsk: true,
  screenShareAudio: true,
}

export function effectiveVoiceJoinPreferences(
  preferences: VoiceJoinPreferences,
): VoiceJoinPreferences {
  return {
    micEnabled: preferences.deafened ? false : preferences.micEnabled,
    deafened: preferences.deafened,
  }
}

function parseNoiseSuppression(value: unknown): NoiseSuppressionMode {
  if (value === 'disabled' || value === 'browser' || value === 'enhanced') {
    return value
  }
  if (value === true) return 'browser'
  if (value === false) return 'disabled'
  return DEFAULT_STATE.noiseSuppression
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
  return DEFAULT_STATE.screenShareQuality
}

function parseScreenShareCodec(value: unknown): ScreenShareCodec {
  if (
    value === 'auto' ||
    value === 'vp8' ||
    value === 'h264' ||
    value === 'vp9' ||
    value === 'av1'
  ) {
    return value
  }
  return DEFAULT_STATE.screenShareCodec
}

function clampUnitInterval(value: unknown, fallback: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(1, Math.max(0, Number(value.toFixed(3))))
}

function loadState(): VoicePreferenceState {
  if (typeof window === 'undefined') return DEFAULT_STATE
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_STATE
    const parsed = JSON.parse(raw) as Partial<VoicePreferenceState> & {
      noiseSupression?: unknown
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
      outputVolume:
        typeof parsed.outputVolume === 'number' &&
        parsed.outputVolume >= 0 &&
        parsed.outputVolume <= VOICE_OUTPUT_VOLUME_MAX
          ? parsed.outputVolume
          : DEFAULT_STATE.outputVolume,
      echoCancellation:
        typeof parsed.echoCancellation === 'boolean'
          ? parsed.echoCancellation
          : DEFAULT_STATE.echoCancellation,
      noiseSuppression: parseNoiseSuppression(
        parsed.noiseSuppression ?? parsed.noiseSupression,
      ),
      autoGainControl:
        typeof parsed.autoGainControl === 'boolean'
          ? parsed.autoGainControl
          : DEFAULT_STATE.autoGainControl,
      voiceGateEnabled:
        typeof parsed.voiceGateEnabled === 'boolean'
          ? parsed.voiceGateEnabled
          : DEFAULT_STATE.voiceGateEnabled,
      voiceGateThreshold: clampUnitInterval(
        parsed.voiceGateThreshold,
        DEFAULT_STATE.voiceGateThreshold,
      ),
      autoBalanceEnabled:
        typeof parsed.autoBalanceEnabled === 'boolean'
          ? parsed.autoBalanceEnabled
          : DEFAULT_STATE.autoBalanceEnabled,
      autoBalanceStrength: clampUnitInterval(
        parsed.autoBalanceStrength,
        DEFAULT_STATE.autoBalanceStrength,
      ),
      screenShareQuality: parseScreenShareQuality(parsed.screenShareQuality),
      screenShareCodec: parseScreenShareCodec(parsed.screenShareCodec),
      screenShareQualityAsk:
        typeof parsed.screenShareQualityAsk === 'boolean'
          ? parsed.screenShareQualityAsk
          : DEFAULT_STATE.screenShareQualityAsk,
      screenShareAudio:
        typeof parsed.screenShareAudio === 'boolean'
          ? parsed.screenShareAudio
          : DEFAULT_STATE.screenShareAudio,
    }
  } catch {
    return DEFAULT_STATE
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

function patch(partial: Partial<VoicePreferenceState>) {
  state = { ...state, ...partial }
  persist()
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
  getOutputVolume: () => state.outputVolume,
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
  setOutputVolume: (outputVolume: number) => {
    const next = Math.min(
      VOICE_OUTPUT_VOLUME_MAX,
      Math.max(0, Number(outputVolume.toFixed(2))),
    )
    if (state.outputVolume === next) return
    patch({ outputVolume: next })
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
  setNoiseSuppression: (noiseSuppression: NoiseSuppressionMode) => {
    if (state.noiseSuppression === noiseSuppression) return
    patch({ noiseSuppression })
  },
  setAutoGainControl: (autoGainControl: boolean) => {
    if (state.autoGainControl === autoGainControl) return
    patch({ autoGainControl })
  },
  setVoiceGateEnabled: (voiceGateEnabled: boolean) => {
    if (state.voiceGateEnabled === voiceGateEnabled) return
    patch({ voiceGateEnabled })
  },
  setVoiceGateThreshold: (voiceGateThreshold: number) => {
    const next = clampUnitInterval(
      voiceGateThreshold,
      DEFAULT_STATE.voiceGateThreshold,
    )
    if (state.voiceGateThreshold === next) return
    patch({ voiceGateThreshold: next })
  },
  setAutoBalanceEnabled: (autoBalanceEnabled: boolean) => {
    if (state.autoBalanceEnabled === autoBalanceEnabled) return
    patch({ autoBalanceEnabled })
  },
  setAutoBalanceStrength: (autoBalanceStrength: number) => {
    const next = clampUnitInterval(
      autoBalanceStrength,
      DEFAULT_STATE.autoBalanceStrength,
    )
    if (state.autoBalanceStrength === next) return
    patch({ autoBalanceStrength: next })
  },
  setScreenShareQuality: (screenShareQuality: ScreenShareQualityName) => {
    if (state.screenShareQuality === screenShareQuality) return
    patch({ screenShareQuality })
  },
  setScreenShareCodec: (screenShareCodec: ScreenShareCodec) => {
    if (state.screenShareCodec === screenShareCodec) return
    patch({ screenShareCodec })
  },
  setScreenShareQualityAsk: (screenShareQualityAsk: boolean) => {
    if (state.screenShareQualityAsk === screenShareQualityAsk) return
    patch({ screenShareQualityAsk })
  },
  setScreenShareAudio: (screenShareAudio: boolean) => {
    if (state.screenShareAudio === screenShareAudio) return
    patch({ screenShareAudio })
  },
}

export function readVoicePreferences() {
  return voicePreferenceStore.getState()
}
