import type {
  AuthoritativeVoiceSnapshot,
  VoiceLease,
  VoiceMediaDesiredState,
  VoiceMembership,
  VoiceRtcEngine,
} from './voice-types'

export type VoiceReservationRequest = Readonly<{
  channelId: string
  rtcEngine: VoiceRtcEngine
  clientInstanceId: string
  operationId: string
  connectionEpoch: string
  media: VoiceMediaDesiredState
  recipients?: readonly string[]
  suppressCallNotifications?: boolean
}>

export type VoiceCancellation = Readonly<{
  rtcEngine: VoiceRtcEngine
  clientInstanceId: string
  operationId: string
  connectionEpoch: string
  reason: 'superseded' | 'connect_failed' | 'commit_timeout' | 'leave'
}>

export type VoiceSelfStateUpdate = Readonly<{
  channelId: string
  rtcEngine: VoiceRtcEngine
  clientInstanceId: string
  operationId: string
  connectionEpoch: string
  userMuted: boolean
  userDeafened: boolean
}>

export type VoiceAuthorityEvent =
  | Readonly<{
      type: 'snapshot'
      snapshot: AuthoritativeVoiceSnapshot
    }>
  | Readonly<{
      type: 'controlUnavailable'
    }>
  | Readonly<{
      type: 'controlReady'
    }>
  | Readonly<{
      type: 'forcedMove'
      from: VoiceMembership
      lease: VoiceLease
    }>

export interface VoiceAuthorityAdapter {
  reserve(
    input: VoiceReservationRequest,
    signal: AbortSignal,
  ): Promise<VoiceLease>
  cancel(input: VoiceCancellation): Promise<void>
  updateSelfState(input: VoiceSelfStateUpdate): Promise<void>
  subscribe(listener: (event: VoiceAuthorityEvent) => void): () => void
  requestSnapshot(): Promise<void>
}
