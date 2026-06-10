export type DesktopScreenShareQualityName = 'low' | 'high' | 'high60' | 'text'
export type DesktopScreenShareCodec = 'auto' | 'av1'
export type DesktopScreenShareCaptureMode = 'auto' | 'native'

export type DesktopVoiceSettings = {
  micEnabled: boolean
  deafened: boolean
  preferredAudioInputDevice?: string
  preferredAudioOutputDevice?: string
  preferredVideoDevice?: string
  inputVolume: number
  outputVolume: number
  noiseSuppression: boolean
  echoCancellation: boolean
  voiceGateEnabled: boolean
  voiceGateThresholdDb: number
  voiceGateAutoThreshold: boolean
  screenShareQuality: DesktopScreenShareQualityName
  screenShareCodec: DesktopScreenShareCodec
  screenShareAudio: boolean
  screenShareCaptureMode: DesktopScreenShareCaptureMode
}

export type DesktopVoiceListenerSettings = {
  userVolumes: Record<string, number>
  userMutes: Record<string, boolean>
  streamVolumes: Record<string, number>
  streamMutes: Record<string, boolean>
}

export type DesktopOverlayGameSettings = {
  id: string
  processName: string
  processPath: string | null
  title: string
  enabled: boolean
  lastSeenAt: number
}

export type DesktopOverlaySettings = {
  enabled: boolean
  games: DesktopOverlayGameSettings[]
}

export type DesktopLocalSettings = {
  version: 1
  voice: DesktopVoiceSettings
  voiceListener: DesktopVoiceListenerSettings
  overlay: DesktopOverlaySettings
}

export type DesktopVoiceSettingsPatch = Partial<DesktopVoiceSettings>
export type DesktopVoiceListenerSettingsPatch =
  Partial<DesktopVoiceListenerSettings>
export type DesktopOverlaySettingsPatch = Partial<DesktopOverlaySettings>

export type DesktopLocalSettingsPatch = {
  voice?: DesktopVoiceSettingsPatch
  voiceListener?: DesktopVoiceListenerSettingsPatch
  overlay?: DesktopOverlaySettingsPatch
}

const VOICE_VOLUME_MAX = 3
const DEFAULT_VOICE_GATE_THRESHOLD_DB = -28

export const DEFAULT_DESKTOP_VOICE_SETTINGS: DesktopVoiceSettings = {
  micEnabled: true,
  deafened: false,
  inputVolume: 1,
  outputVolume: 1,
  noiseSuppression: true,
  echoCancellation: true,
  voiceGateEnabled: true,
  voiceGateThresholdDb: DEFAULT_VOICE_GATE_THRESHOLD_DB,
  voiceGateAutoThreshold: true,
  screenShareQuality: 'low',
  screenShareCodec: 'auto',
  screenShareAudio: true,
  screenShareCaptureMode: 'auto',
}

export const DEFAULT_DESKTOP_VOICE_LISTENER_SETTINGS: DesktopVoiceListenerSettings = {
  userVolumes: {},
  userMutes: {},
  streamVolumes: {},
  streamMutes: {},
}

export const DEFAULT_DESKTOP_OVERLAY_SETTINGS: DesktopOverlaySettings = {
  enabled: true,
  games: [],
}

export const DEFAULT_DESKTOP_LOCAL_SETTINGS: DesktopLocalSettings = {
  version: 1,
  voice: DEFAULT_DESKTOP_VOICE_SETTINGS,
  voiceListener: DEFAULT_DESKTOP_VOICE_LISTENER_SETTINGS,
  overlay: DEFAULT_DESKTOP_OVERLAY_SETTINGS,
}

function objectRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function booleanOrDefault(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback
}

function stringOrUndefined(value: unknown) {
  return typeof value === 'string' ? value : undefined
}

function stringOrNull(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  return Number(
    Math.min(max, Math.max(min, finiteNumber(value, fallback))).toFixed(2),
  )
}

function screenShareQualityOrDefault(
  value: unknown,
  fallback: DesktopScreenShareQualityName,
) {
  if (
    value === 'low' ||
    value === 'high' ||
    value === 'high60' ||
    value === 'text'
  ) {
    return value
  }
  return fallback
}

function screenShareCodecOrDefault(
  value: unknown,
  fallback: DesktopScreenShareCodec,
) {
  return value === 'av1' ? 'av1' : fallback
}

function screenShareCaptureModeOrDefault(
  value: unknown,
  fallback: DesktopScreenShareCaptureMode,
) {
  return value === 'native' || value === 'auto' ? value : fallback
}

function normalizeNumberRecord(value: unknown) {
  const next: Record<string, number> = {}
  for (const [key, entry] of Object.entries(objectRecord(value))) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) continue
    next[key] = clampNumber(entry, 1, 0, VOICE_VOLUME_MAX)
  }
  return next
}

function normalizeBooleanRecord(value: unknown) {
  const next: Record<string, boolean> = {}
  for (const [key, entry] of Object.entries(objectRecord(value))) {
    if (entry === true) next[key] = true
  }
  return next
}

export function normalizeDesktopVoiceSettings(
  value: unknown,
  defaults: DesktopVoiceSettings = DEFAULT_DESKTOP_VOICE_SETTINGS,
): DesktopVoiceSettings {
  const settings = objectRecord(value)
  return {
    micEnabled: booleanOrDefault(settings.micEnabled, defaults.micEnabled),
    deafened: booleanOrDefault(settings.deafened, defaults.deafened),
    preferredAudioInputDevice: stringOrUndefined(
      settings.preferredAudioInputDevice,
    ),
    preferredAudioOutputDevice: stringOrUndefined(
      settings.preferredAudioOutputDevice,
    ),
    preferredVideoDevice: stringOrUndefined(settings.preferredVideoDevice),
    inputVolume: clampNumber(
      settings.inputVolume,
      defaults.inputVolume,
      0,
      VOICE_VOLUME_MAX,
    ),
    outputVolume: clampNumber(
      settings.outputVolume,
      defaults.outputVolume,
      0,
      VOICE_VOLUME_MAX,
    ),
    noiseSuppression: booleanOrDefault(
      settings.noiseSuppression,
      defaults.noiseSuppression,
    ),
    echoCancellation: booleanOrDefault(
      settings.echoCancellation,
      defaults.echoCancellation,
    ),
    voiceGateEnabled: booleanOrDefault(
      settings.voiceGateEnabled,
      defaults.voiceGateEnabled,
    ),
    voiceGateThresholdDb: clampNumber(
      settings.voiceGateThresholdDb,
      defaults.voiceGateThresholdDb,
      -100,
      0,
    ),
    voiceGateAutoThreshold: booleanOrDefault(
      settings.voiceGateAutoThreshold,
      defaults.voiceGateAutoThreshold,
    ),
    screenShareQuality: screenShareQualityOrDefault(
      settings.screenShareQuality,
      defaults.screenShareQuality,
    ),
    screenShareCodec: screenShareCodecOrDefault(
      settings.screenShareCodec,
      defaults.screenShareCodec,
    ),
    screenShareAudio: booleanOrDefault(
      settings.screenShareAudio,
      defaults.screenShareAudio,
    ),
    screenShareCaptureMode: screenShareCaptureModeOrDefault(
      settings.screenShareCaptureMode,
      defaults.screenShareCaptureMode,
    ),
  }
}

export function normalizeDesktopVoiceListenerSettings(
  value: unknown,
): DesktopVoiceListenerSettings {
  const settings = objectRecord(value)
  return {
    userVolumes: normalizeNumberRecord(settings.userVolumes),
    userMutes: normalizeBooleanRecord(settings.userMutes),
    streamVolumes: normalizeNumberRecord(settings.streamVolumes),
    streamMutes: normalizeBooleanRecord(settings.streamMutes),
  }
}

export function normalizeDesktopOverlaySettings(
  value: unknown,
  defaults: DesktopOverlaySettings = DEFAULT_DESKTOP_OVERLAY_SETTINGS,
): DesktopOverlaySettings {
  const settings = objectRecord(value)
  return {
    enabled: booleanOrDefault(settings.enabled, defaults.enabled),
    games: Array.isArray(settings.games)
      ? settings.games.flatMap(normalizeDesktopOverlayGameSettings)
      : [...defaults.games],
  }
}

function normalizeDesktopOverlayGameSettings(
  value: unknown,
): DesktopOverlayGameSettings[] {
  const game = objectRecord(value)
  if (
    !nonEmptyString(game.id) ||
    !nonEmptyString(game.processName) ||
    !nonEmptyString(game.title) ||
    typeof game.enabled !== 'boolean' ||
    typeof game.lastSeenAt !== 'number' ||
    !Number.isFinite(game.lastSeenAt)
  ) {
    return []
  }

  return [
    {
      id: game.id,
      processName: game.processName,
      processPath: stringOrNull(game.processPath),
      title: game.title,
      enabled: game.enabled,
      lastSeenAt: game.lastSeenAt,
    },
  ]
}

export function normalizeDesktopLocalSettings(
  value: unknown,
  defaults: DesktopLocalSettings = DEFAULT_DESKTOP_LOCAL_SETTINGS,
): DesktopLocalSettings {
  const settings = objectRecord(value)
  return {
    version: 1,
    voice: normalizeDesktopVoiceSettings(settings.voice, defaults.voice),
    voiceListener: normalizeDesktopVoiceListenerSettings(settings.voiceListener),
    overlay: normalizeDesktopOverlaySettings(settings.overlay, defaults.overlay),
  }
}

export function normalizeDesktopVoiceSettingsPatch(
  value: unknown,
): DesktopVoiceSettingsPatch | undefined {
  const patch = objectRecord(value)
  const next: DesktopVoiceSettingsPatch = {}

  if ('micEnabled' in patch && typeof patch.micEnabled === 'boolean') {
    next.micEnabled = patch.micEnabled
  }
  if ('deafened' in patch && typeof patch.deafened === 'boolean') {
    next.deafened = patch.deafened
  }
  if ('preferredAudioInputDevice' in patch) {
    next.preferredAudioInputDevice = stringOrUndefined(
      patch.preferredAudioInputDevice,
    )
  }
  if ('preferredAudioOutputDevice' in patch) {
    next.preferredAudioOutputDevice = stringOrUndefined(
      patch.preferredAudioOutputDevice,
    )
  }
  if ('preferredVideoDevice' in patch) {
    next.preferredVideoDevice = stringOrUndefined(patch.preferredVideoDevice)
  }
  if ('inputVolume' in patch) {
    next.inputVolume = clampNumber(patch.inputVolume, 1, 0, VOICE_VOLUME_MAX)
  }
  if ('outputVolume' in patch) {
    next.outputVolume = clampNumber(patch.outputVolume, 1, 0, VOICE_VOLUME_MAX)
  }
  if (
    'noiseSuppression' in patch &&
    typeof patch.noiseSuppression === 'boolean'
  ) {
    next.noiseSuppression = patch.noiseSuppression
  }
  if (
    'echoCancellation' in patch &&
    typeof patch.echoCancellation === 'boolean'
  ) {
    next.echoCancellation = patch.echoCancellation
  }
  if (
    'voiceGateEnabled' in patch &&
    typeof patch.voiceGateEnabled === 'boolean'
  ) {
    next.voiceGateEnabled = patch.voiceGateEnabled
  }
  if ('voiceGateThresholdDb' in patch) {
    next.voiceGateThresholdDb = clampNumber(
      patch.voiceGateThresholdDb,
      DEFAULT_VOICE_GATE_THRESHOLD_DB,
      -100,
      0,
    )
  }
  if (
    'voiceGateAutoThreshold' in patch &&
    typeof patch.voiceGateAutoThreshold === 'boolean'
  ) {
    next.voiceGateAutoThreshold = patch.voiceGateAutoThreshold
  }
  if ('screenShareQuality' in patch) {
    next.screenShareQuality = screenShareQualityOrDefault(
      patch.screenShareQuality,
      DEFAULT_DESKTOP_VOICE_SETTINGS.screenShareQuality,
    )
  }
  if ('screenShareCodec' in patch) {
    next.screenShareCodec = screenShareCodecOrDefault(
      patch.screenShareCodec,
      DEFAULT_DESKTOP_VOICE_SETTINGS.screenShareCodec,
    )
  }
  if ('screenShareAudio' in patch && typeof patch.screenShareAudio === 'boolean') {
    next.screenShareAudio = patch.screenShareAudio
  }
  if ('screenShareCaptureMode' in patch) {
    next.screenShareCaptureMode = screenShareCaptureModeOrDefault(
      patch.screenShareCaptureMode,
      DEFAULT_DESKTOP_VOICE_SETTINGS.screenShareCaptureMode,
    )
  }

  return Object.keys(next).length > 0 ? next : undefined
}

export function normalizeDesktopVoiceListenerSettingsPatch(
  value: unknown,
): DesktopVoiceListenerSettingsPatch | undefined {
  const patch = objectRecord(value)
  const next: DesktopVoiceListenerSettingsPatch = {}
  if ('userVolumes' in patch) {
    next.userVolumes = normalizeNumberRecord(patch.userVolumes)
  }
  if ('userMutes' in patch) {
    next.userMutes = normalizeBooleanRecord(patch.userMutes)
  }
  if ('streamVolumes' in patch) {
    next.streamVolumes = normalizeNumberRecord(patch.streamVolumes)
  }
  if ('streamMutes' in patch) {
    next.streamMutes = normalizeBooleanRecord(patch.streamMutes)
  }
  return Object.keys(next).length > 0 ? next : undefined
}

export function normalizeDesktopOverlaySettingsPatch(
  value: unknown,
): DesktopOverlaySettingsPatch | undefined {
  const patch = objectRecord(value)
  const next: DesktopOverlaySettingsPatch = {}
  if ('enabled' in patch && typeof patch.enabled === 'boolean') {
    next.enabled = patch.enabled
  }
  if ('games' in patch && Array.isArray(patch.games)) {
    next.games = patch.games.flatMap(normalizeDesktopOverlayGameSettings)
  }
  return Object.keys(next).length > 0 ? next : undefined
}

export function normalizeDesktopLocalSettingsPatch(
  value: unknown,
): DesktopLocalSettingsPatch {
  const patch = objectRecord(value)
  const next: DesktopLocalSettingsPatch = {}
  const voice = normalizeDesktopVoiceSettingsPatch(patch.voice)
  const voiceListener = normalizeDesktopVoiceListenerSettingsPatch(
    patch.voiceListener,
  )
  const overlay = normalizeDesktopOverlaySettingsPatch(patch.overlay)
  if (voice) next.voice = voice
  if (voiceListener) next.voiceListener = voiceListener
  if (overlay) next.overlay = overlay
  return next
}
