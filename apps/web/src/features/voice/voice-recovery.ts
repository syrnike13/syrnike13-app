import type { VoiceParticipantsByChannel } from '#/features/sync/voice-types'
import type { VoiceStatus } from '#/features/voice/voice-mic-status'

export type VoiceRecoveryReason =
  | 'idle'
  | 'gateway_disconnected'
  | 'healthy'
  | 'local_not_connected'
  | 'missing_server_state'
  | 'server_state_moved_elsewhere'
  | 'publisher_unhealthy'
  | 'flags_mismatch'

export type VoiceRecoveryAction =
  | { type: 'none'; reason: VoiceRecoveryReason }
  | {
      type: 'stop_superseded'
      reason: 'server_state_moved_elsewhere'
      channelId: string
    }
  | {
      type: 'rejoin'
      reason: 'missing_server_state' | 'local_not_connected'
      channelId: string
    }
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
  desiredChannelId: string | null
  userId: string | null
  status: VoiceStatus
  voiceParticipants: VoiceParticipantsByChannel
  canTrustServerState: boolean
  desiredSelfMute: boolean
  desiredSelfDeaf: boolean
  wantsMic: boolean
  selfMonitoringActive: boolean
  publisherHealthy: boolean
}

function findUserVoiceChannel(
  voiceParticipants: VoiceParticipantsByChannel,
  userId: string,
) {
  for (const [channelId, channelMap] of Object.entries(voiceParticipants)) {
    if (channelMap?.[userId]) return channelId
  }
  return null
}

export function decideVoiceRecoveryAction(
  input: VoiceRecoveryInput,
): VoiceRecoveryAction {
  if (!input.gatewayConnected) {
    return { type: 'none', reason: 'gateway_disconnected' }
  }

  const recoveryChannelId = input.channelId ?? input.desiredChannelId

  if (!recoveryChannelId || !input.userId) {
    return { type: 'none', reason: 'idle' }
  }

  const serverState =
    input.voiceParticipants[recoveryChannelId]?.[input.userId]
  const serverChannelId = findUserVoiceChannel(
    input.voiceParticipants,
    input.userId,
  )

  if (serverChannelId && serverChannelId !== recoveryChannelId) {
    return {
      type: 'stop_superseded',
      reason: 'server_state_moved_elsewhere',
      channelId: serverChannelId,
    }
  }

  if (!serverState && input.canTrustServerState) {
    return {
      type: 'rejoin',
      reason: 'missing_server_state',
      channelId: recoveryChannelId,
    }
  }

  if (input.status !== 'connected') {
    return {
      type: 'rejoin',
      reason: 'local_not_connected',
      channelId: recoveryChannelId,
    }
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
