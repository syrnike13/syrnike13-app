import { Option, Schema } from 'effect'

const VoiceIdentifierSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
)

const RemoteAudioVolumeSchema = Schema.Finite.check(
  Schema.isBetween({ minimum: 0, maximum: 3 }),
)

const remoteAudioSettingsMap = <Value extends Schema.Top>(value: Value) =>
  Schema.Record(VoiceIdentifierSchema, value).check(
    Schema.makeFilter(
      (settings) => Object.keys(settings).length <= 512,
      { expected: 'a settings map with at most 512 entries' },
    ),
  )

export const VoiceRemoteAudioSettingsSchema = Schema.Struct({
  revision: Schema.Natural,
  userVolumes: remoteAudioSettingsMap(RemoteAudioVolumeSchema),
  userMutes: remoteAudioSettingsMap(Schema.Boolean),
  streamVolumes: remoteAudioSettingsMap(RemoteAudioVolumeSchema),
  streamMutes: remoteAudioSettingsMap(Schema.Boolean),
})

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
  hresult?: number
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
  hresult?: number
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

export type VoiceRemoteAudioSettings =
  typeof VoiceRemoteAudioSettingsSchema.Type

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

const voiceFiniteNumber = (minimum: number, maximum: number) =>
  Schema.Finite.check(Schema.isBetween({ minimum, maximum }))

const voiceInteger = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }))

const VoiceFailureSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
  stage: Schema.optional(Schema.String),
  hresult: Schema.optional(Schema.Int),
})

const VoiceMediaSnapshotSchema = Schema.Struct({
  state: Schema.Literals(['off', 'starting', 'running', 'muted', 'failed']),
  error: Schema.optional(VoiceFailureSchema),
})

export const VoiceCommandSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('join'),
    channelId: VoiceIdentifierSchema,
    recipients: Schema.optional(
      Schema.Array(VoiceIdentifierSchema).check(Schema.isMaxLength(512)),
    ),
  }),
  Schema.Struct({ type: Schema.Literal('leave') }),
  Schema.Struct({
    type: Schema.Literal('setUserMuted'),
    muted: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal('setUserDeafened'),
    deafened: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal('setInputMode'),
    mode: Schema.Literals(['voice_activity', 'push_to_talk']),
  }),
  Schema.Struct({
    type: Schema.Literal('setPushToTalkHeld'),
    held: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal('setSystemPrivacyMuted'),
    muted: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal('setSelfMonitoringActive'),
    active: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal('configureMicrophone'),
    deviceId: Schema.optional(VoiceIdentifierSchema),
    bypassSystemAudioInputProcessing: Schema.Boolean,
    automaticGainControl: Schema.Boolean,
    noiseSuppression: Schema.Boolean,
    echoCancellation: Schema.Boolean,
    inputVolume: voiceFiniteNumber(0, 4),
    voiceGateEnabled: Schema.Boolean,
    voiceGateThresholdDb: voiceFiniteNumber(-100, 0),
    voiceGateAutoThreshold: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal('configureOutput'),
    deviceId: Schema.optional(VoiceIdentifierSchema),
    volume: voiceFiniteNumber(0, 3),
  }),
  Schema.Struct({
    type: Schema.Literal('configureRemoteAudio'),
    settings: VoiceRemoteAudioSettingsSchema,
  }),
  Schema.Struct({
    type: Schema.Literal('setCamera'),
    enabled: Schema.Boolean,
    deviceId: Schema.optional(VoiceIdentifierSchema),
  }),
  Schema.Struct({
    type: Schema.Literal('setScreen'),
    enabled: Schema.Boolean,
    sourceId: Schema.optional(VoiceIdentifierSchema),
    audioEnabled: Schema.optional(Schema.Boolean),
    width: Schema.optional(voiceInteger(64, 7_680)),
    height: Schema.optional(voiceInteger(64, 4_320)),
    fps: Schema.optional(voiceInteger(1, 240)),
    bitrate: Schema.optional(voiceInteger(32_000, 100_000_000)),
    audioBitrate: Schema.optional(voiceInteger(6_000, 512_000)),
  }),
  Schema.Struct({ type: Schema.Literal('retryVoice') }),
  Schema.Struct({
    type: Schema.Literal('retryMedia'),
    kind: Schema.Literals([
      'microphone',
      'output',
      'camera',
      'screen',
      'screen_audio',
    ]),
  }),
])

export const VoiceSnapshotSchema = Schema.Struct({
  intentChannelId: Schema.Union([Schema.Null, VoiceIdentifierSchema]),
  membershipChannelId: Schema.Union([Schema.Null, VoiceIdentifierSchema]),
  connection: Schema.Literals([
    'disconnected',
    'connecting',
    'connected',
    'recovering',
    'failed',
  ]),
  operationId: Schema.optional(VoiceIdentifierSchema),
  connectionEpoch: Schema.optional(VoiceIdentifierSchema),
  retryAttempt: Schema.optional(Schema.Natural),
  failure: Schema.optional(VoiceFailureSchema),
  microphone: VoiceMediaSnapshotSchema,
  output: VoiceMediaSnapshotSchema,
  camera: VoiceMediaSnapshotSchema,
  screen: VoiceMediaSnapshotSchema,
  screenAudio: VoiceMediaSnapshotSchema,
  userMuted: Schema.Boolean,
  userDeafened: Schema.Boolean,
  serverMuted: Schema.Boolean,
  serverDeafened: Schema.Boolean,
  systemPrivacyMuted: Schema.Boolean,
  monitoringMuted: Schema.Boolean,
  inputMode: Schema.Literals(['voice_activity', 'push_to_talk']),
  pushToTalkHeld: Schema.Boolean,
  effectiveMuted: Schema.Boolean,
  speakingUserIds: Schema.Array(VoiceIdentifierSchema),
})

export function isVoiceCommand(value: unknown): value is VoiceCommand {
  return Option.isSome(
    Schema.decodeUnknownOption(VoiceCommandSchema)(value),
  )
}

export function isVoiceRemoteAudioSettings(
  value: unknown,
): value is VoiceRemoteAudioSettings {
  return Option.isSome(
    Schema.decodeUnknownOption(VoiceRemoteAudioSettingsSchema)(value),
  )
}

export function isVoiceSnapshot(value: unknown): value is VoiceSnapshot {
  return Option.isSome(
    Schema.decodeUnknownOption(VoiceSnapshotSchema)(value),
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
