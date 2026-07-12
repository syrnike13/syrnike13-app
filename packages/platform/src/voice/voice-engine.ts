import type {
  VoiceFailure,
  VoiceLease,
  VoiceMediaDesiredState,
  VoiceMediaKind,
  VoiceMediaSnapshot,
  VoiceRemoteAudioSettings,
} from './voice-types'

export type VoiceDisconnectCause =
  | 'leave'
  | 'move'
  | 'superseded'
  | 'recovery'
  | 'shutdown'

export type VoiceEngineEvent =
  | Readonly<{
      type: 'terminalFailure'
      failure: VoiceFailure
      operationId: string
      connectionEpoch: string
    }>
  | Readonly<{
      type: 'mediaState'
      kind: VoiceMediaKind
      media: VoiceMediaSnapshot
      operationId: string
      connectionEpoch: string
    }>
  | Readonly<{
      type: 'transientReconnectStarted'
      operationId: string
      connectionEpoch: string
    }>
  | Readonly<{
      type: 'transientReconnectSucceeded'
      operationId: string
      connectionEpoch: string
    }>
  | Readonly<{
      type: 'speakingChanged'
      /** Canonical user identities whose audible microphone activity is open. */
      participantIdentities: readonly string[]
      operationId: string
      connectionEpoch: string
    }>

export interface RtcEngineAdapter {
  connect(
    lease: VoiceLease,
    desired: VoiceMediaDesiredState,
    signal: AbortSignal,
  ): Promise<void>
  disconnect(cause: VoiceDisconnectCause): Promise<void>
  updateDesiredMedia(desired: VoiceMediaDesiredState): void
  updateRemoteAudioSettings(settings: VoiceRemoteAudioSettings): void
  retryMedia(kind: VoiceMediaKind): void
  subscribe(listener: (event: VoiceEngineEvent) => void): () => void
}
