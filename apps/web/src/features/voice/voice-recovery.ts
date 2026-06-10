import type { VoiceParticipantsByChannel } from '#/features/sync/voice-types'
import type { VoiceStatus } from '#/features/voice/voice-mic-status'

export type VoiceRecoveryReason =
  | 'idle'
  | 'gateway_disconnected'
  | 'healthy'
  | 'missing_server_state'
  | 'publisher_unhealthy'
  | 'flags_mismatch'

export type VoiceRecoveryAction =
  | { type: 'none'; reason: VoiceRecoveryReason }
  | { type: 'rejoin'; reason: 'missing_server_state' }
  | { type: 'repair_publisher'; reason: 'publisher_unhealthy' }
  | {
      type: 'send_flags'
      reason: 'flags_mismatch'
      selfMute: boolean
      selfDeaf: boolean
    }

export type VoiceRecoveryInput = {
  gatewayConnected: boolean
  channelId: string | null
  userId: string | undefined
  status: VoiceStatus
  voiceParticipants: VoiceParticipantsByChannel
  canTrustServerState: boolean
  desiredSelfMute: boolean
  desiredSelfDeaf: boolean
  wantsMic: boolean
  selfMonitoringActive: boolean
  publisherHealthy: boolean
}

export function decideVoiceRecoveryAction(
  input: VoiceRecoveryInput,
): VoiceRecoveryAction {
  if (!input.gatewayConnected) {
    return { type: 'none', reason: 'gateway_disconnected' }
  }

  if (input.status !== 'connected' || !input.channelId || !input.userId) {
    return { type: 'none', reason: 'idle' }
  }

  const serverState =
    input.voiceParticipants[input.channelId]?.[input.userId]

  if (!serverState && input.canTrustServerState) {
    return { type: 'rejoin', reason: 'missing_server_state' }
  }
  if (!serverState) {
    return { type: 'none', reason: 'healthy' }
  }

  if (
    input.wantsMic &&
    !input.desiredSelfMute &&
    !input.desiredSelfDeaf &&
    !input.selfMonitoringActive &&
    !input.publisherHealthy
  ) {
    return { type: 'repair_publisher', reason: 'publisher_unhealthy' }
  }

  if (
    serverState.self_mute !== input.desiredSelfMute ||
    serverState.self_deaf !== input.desiredSelfDeaf
  ) {
    return {
      type: 'send_flags',
      reason: 'flags_mismatch',
      selfMute: input.desiredSelfMute,
      selfDeaf: input.desiredSelfDeaf,
    }
  }

  return { type: 'none', reason: 'healthy' }
}
