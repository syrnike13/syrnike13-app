export type VoiceRtcEngine = 'web' | 'windows_native'

export type VoiceConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'recovering'
  | 'failed'

export type VoiceInputMode = 'voice_activity' | 'push_to_talk'

export type VoiceMediaKind =
  | 'microphone'
  | 'output'
  | 'camera'
  | 'screen'
  | 'screen_audio'

export type VoiceMediaState =
  | 'off'
  | 'starting'
  | 'running'
  | 'muted'
  | 'failed'

export type VoiceMediaError = Readonly<{
  code: string
  message: string
  retryable: boolean
  stage?: string
}>

export type VoiceMediaSnapshot = Readonly<{
  state: VoiceMediaState
  error?: VoiceMediaError
}>

export type VoiceMediaDesiredState = Readonly<{
  userMuted: boolean
  userDeafened: boolean
  serverMuted: boolean
  serverDeafened: boolean
  systemPrivacyMuted: boolean
  monitoringMuted: boolean
  inputMode: VoiceInputMode
  pushToTalkHeld: boolean
  effectiveMuted: boolean
  microphoneDeviceId?: string
  bypassSystemAudioInputProcessing: boolean
  automaticGainControl: boolean
  noiseSuppression: boolean
  echoCancellation: boolean
  inputVolume: number
  voiceGateEnabled: boolean
  voiceGateThresholdDb: number
  voiceGateAutoThreshold: boolean
  outputDeviceId?: string
  outputVolume: number
  cameraEnabled: boolean
  cameraDeviceId?: string
  screenEnabled: boolean
  screenSourceId?: string
  screenAudioEnabled: boolean
  screenWidth?: number
  screenHeight?: number
  screenFps?: number
  screenBitrate?: number
  screenAudioBitrate?: number
}>

export type VoiceCredential = Readonly<{
  url: string
  token: string
  participantIdentity: string
}>

export type VoiceLease = Readonly<{
  channelId: string
  rtcEngine: VoiceRtcEngine
  clientInstanceId: string
  operationId: string
  connectionEpoch: string
  authorityVersion: number
  credential: VoiceCredential
}>

export type VoiceMembership = Readonly<{
  channelId: string
  rtcEngine: VoiceRtcEngine
  clientInstanceId: string
  operationId: string
  connectionEpoch: string
}>

export type AuthoritativeVoiceSnapshot = Readonly<{
  authorityVersion: number
  complete: true
  membership: VoiceMembership | null
  serverMuted: boolean
  serverDeafened: boolean
}>

export type VoiceFailure = Readonly<{
  code: string
  message: string
  retryable: boolean
  stage?: string
}>

export type VoiceSnapshot = Readonly<{
  intentChannelId: string | null
  membershipChannelId: string | null
  connection: VoiceConnectionState
  operationId?: string
  connectionEpoch?: string
  retryAttempt?: number
  failure?: VoiceFailure
  microphone: VoiceMediaSnapshot
  output: VoiceMediaSnapshot
  camera: VoiceMediaSnapshot
  screen: VoiceMediaSnapshot
  screenAudio: VoiceMediaSnapshot
  userMuted: boolean
  userDeafened: boolean
  serverMuted: boolean
  serverDeafened: boolean
  systemPrivacyMuted: boolean
  monitoringMuted: boolean
  inputMode: VoiceInputMode
  pushToTalkHeld: boolean
  effectiveMuted: boolean
  speakingUserIds: readonly string[]
}>

export type VoiceRemoteAudioSettings = Readonly<{
  revision: number
  userVolumes: Readonly<Record<string, number>>
  userMutes: Readonly<Record<string, boolean>>
  streamVolumes: Readonly<Record<string, number>>
  streamMutes: Readonly<Record<string, boolean>>
}>

export type VoiceCommand =
  | Readonly<{
      type: 'join'
      channelId: string
      recipients?: readonly string[]
    }>
  | Readonly<{ type: 'leave' }>
  | Readonly<{ type: 'setUserMuted'; muted: boolean }>
  | Readonly<{ type: 'setUserDeafened'; deafened: boolean }>
  | Readonly<{ type: 'setInputMode'; mode: VoiceInputMode }>
  | Readonly<{ type: 'setPushToTalkHeld'; held: boolean }>
  | Readonly<{ type: 'setSystemPrivacyMuted'; muted: boolean }>
  | Readonly<{ type: 'setSelfMonitoringActive'; active: boolean }>
  | Readonly<{
      type: 'configureMicrophone'
      deviceId?: string
      bypassSystemAudioInputProcessing: boolean
      automaticGainControl: boolean
      noiseSuppression: boolean
      echoCancellation: boolean
      inputVolume: number
      voiceGateEnabled: boolean
      voiceGateThresholdDb: number
      voiceGateAutoThreshold: boolean
    }>
  | Readonly<{
      type: 'configureOutput'
      deviceId?: string
      volume: number
    }>
  | Readonly<{
      type: 'setCamera'
      enabled: boolean
      deviceId?: string
    }>
  | Readonly<{
      type: 'setScreen'
      enabled: boolean
      sourceId?: string
      audioEnabled?: boolean
      width?: number
      height?: number
      fps?: number
      bitrate?: number
      audioBitrate?: number
    }>
  | Readonly<{ type: 'retryVoice' }>
  | Readonly<{ type: 'retryMedia'; kind: VoiceMediaKind }>
  | Readonly<{
      type: 'configureRemoteAudio'
      settings: VoiceRemoteAudioSettings
    }>

export function isVoiceCommand(value: unknown): value is VoiceCommand {
  if (!value || typeof value !== 'object') return false
  const command = value as Record<string, unknown>
  switch (command.type) {
    case 'join':
      return (
        validIdentifier(command.channelId) &&
        (command.recipients === undefined ||
          (Array.isArray(command.recipients) &&
            command.recipients.length <= 512 &&
            command.recipients.every(validIdentifier)))
      )
    case 'leave':
    case 'retryVoice':
      return true
    case 'setUserMuted':
      return typeof command.muted === 'boolean'
    case 'setUserDeafened':
      return typeof command.deafened === 'boolean'
    case 'setInputMode':
      return command.mode === 'voice_activity' || command.mode === 'push_to_talk'
    case 'setPushToTalkHeld':
      return typeof command.held === 'boolean'
    case 'setSystemPrivacyMuted':
      return typeof command.muted === 'boolean'
    case 'setSelfMonitoringActive':
      return typeof command.active === 'boolean'
    case 'configureMicrophone':
      return (
        (command.deviceId === undefined || validIdentifier(command.deviceId)) &&
        typeof command.bypassSystemAudioInputProcessing === 'boolean' &&
        typeof command.automaticGainControl === 'boolean' &&
        typeof command.noiseSuppression === 'boolean' &&
        typeof command.echoCancellation === 'boolean' &&
        finiteInRange(command.inputVolume, 0, 4) &&
        typeof command.voiceGateEnabled === 'boolean' &&
        finiteInRange(command.voiceGateThresholdDb, -100, 0) &&
        typeof command.voiceGateAutoThreshold === 'boolean'
      )
    case 'configureOutput':
      return (
        (command.deviceId === undefined || validIdentifier(command.deviceId)) &&
        finiteInRange(command.volume, 0, 3)
      )
    case 'configureRemoteAudio':
      return isVoiceRemoteAudioSettings(command.settings)
    case 'setCamera':
      return (
        typeof command.enabled === 'boolean' &&
        (command.deviceId === undefined || validIdentifier(command.deviceId))
      )
    case 'setScreen':
      return (
        typeof command.enabled === 'boolean' &&
        (command.sourceId === undefined || validIdentifier(command.sourceId)) &&
        (command.audioEnabled === undefined ||
          typeof command.audioEnabled === 'boolean') &&
        optionalInteger(command.width, 64, 7_680) &&
        optionalInteger(command.height, 64, 4_320) &&
        optionalInteger(command.fps, 1, 240) &&
        optionalInteger(command.bitrate, 32_000, 100_000_000) &&
        optionalInteger(command.audioBitrate, 6_000, 512_000)
      )
    case 'retryMedia':
      return (
        command.kind === 'microphone' ||
        command.kind === 'output' ||
        command.kind === 'camera' ||
        command.kind === 'screen' ||
        command.kind === 'screen_audio'
      )
    default:
      return false
  }
}

export function isVoiceRemoteAudioSettings(
  value: unknown,
): value is VoiceRemoteAudioSettings {
  if (!value || typeof value !== 'object') return false
  const settings = value as Record<string, unknown>
  return (
    Number.isSafeInteger(settings.revision) &&
    Number(settings.revision) >= 0 &&
    validSettingsMap(settings.userVolumes, (item) => finiteInRange(item, 0, 3)) &&
    validSettingsMap(settings.userMutes, (item) => typeof item === 'boolean') &&
    validSettingsMap(settings.streamVolumes, (item) => finiteInRange(item, 0, 3)) &&
    validSettingsMap(settings.streamMutes, (item) => typeof item === 'boolean')
  )
}

function validSettingsMap(
  value: unknown,
  validValue: (value: unknown) => boolean,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entries = Object.entries(value)
  return (
    entries.length <= 512 &&
    entries.every(([key, item]) => validIdentifier(key) && validValue(item))
  )
}

export function isVoiceSnapshot(value: unknown): value is VoiceSnapshot {
  if (!value || typeof value !== 'object') return false
  const snapshot = value as Partial<VoiceSnapshot>
  return (
    (snapshot.intentChannelId === null ||
      validIdentifier(snapshot.intentChannelId)) &&
    (snapshot.membershipChannelId === null ||
      validIdentifier(snapshot.membershipChannelId)) &&
    (snapshot.connection === 'disconnected' ||
      snapshot.connection === 'connecting' ||
      snapshot.connection === 'connected' ||
      snapshot.connection === 'recovering' ||
      snapshot.connection === 'failed') &&
    typeof snapshot.userMuted === 'boolean' &&
    typeof snapshot.userDeafened === 'boolean' &&
    typeof snapshot.serverMuted === 'boolean' &&
    typeof snapshot.serverDeafened === 'boolean' &&
    typeof snapshot.systemPrivacyMuted === 'boolean' &&
    typeof snapshot.monitoringMuted === 'boolean' &&
    typeof snapshot.pushToTalkHeld === 'boolean' &&
    typeof snapshot.effectiveMuted === 'boolean' &&
    Array.isArray(snapshot.speakingUserIds) &&
    snapshot.speakingUserIds.every(validIdentifier) &&
    isMediaSnapshot(snapshot.microphone) &&
    isMediaSnapshot(snapshot.output) &&
    isMediaSnapshot(snapshot.camera) &&
    isMediaSnapshot(snapshot.screen) &&
    isMediaSnapshot(snapshot.screenAudio)
  )
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}

function isMediaSnapshot(value: unknown): value is VoiceMediaSnapshot {
  if (!value || typeof value !== 'object') return false
  const media = value as Partial<VoiceMediaSnapshot>
  return (
    media.state === 'off' ||
    media.state === 'starting' ||
    media.state === 'running' ||
    media.state === 'muted' ||
    media.state === 'failed'
  )
}

function optionalInteger(value: unknown, min: number, max: number) {
  return (
    value === undefined ||
    (Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max)
  )
}

function finiteInRange(value: unknown, min: number, max: number) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  )
}

export function computeEffectiveMuted(
  state: Pick<
    VoiceMediaDesiredState,
    | 'userMuted'
    | 'userDeafened'
    | 'serverMuted'
    | 'serverDeafened'
    | 'systemPrivacyMuted'
    | 'monitoringMuted'
    | 'inputMode'
    | 'pushToTalkHeld'
  >,
) {
  return (
    state.userMuted ||
    state.userDeafened ||
    state.serverMuted ||
    state.serverDeafened ||
    state.systemPrivacyMuted ||
    state.monitoringMuted ||
    (state.inputMode === 'push_to_talk' && !state.pushToTalkHeld)
  )
}

export function createInitialVoiceMediaDesiredState(): VoiceMediaDesiredState {
  const state = {
    userMuted: true,
    userDeafened: false,
    serverMuted: false,
    serverDeafened: false,
    systemPrivacyMuted: false,
    monitoringMuted: false,
    inputMode: 'voice_activity' as const,
    pushToTalkHeld: false,
    bypassSystemAudioInputProcessing: true,
    automaticGainControl: true,
    noiseSuppression: true,
    echoCancellation: false,
    inputVolume: 1,
    voiceGateEnabled: true,
    voiceGateThresholdDb: -28,
    voiceGateAutoThreshold: true,
    outputVolume: 1,
    cameraEnabled: false,
    screenEnabled: false,
    screenAudioEnabled: false,
  }
  return { ...state, effectiveMuted: computeEffectiveMuted(state) }
}

export function createInactiveMediaSnapshot(): VoiceMediaSnapshot {
  return { state: 'off' }
}
