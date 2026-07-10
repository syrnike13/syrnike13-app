import type { GatewayServerEvent } from '#/features/sync/types'

export type VoiceIntentGatewayAction =
  | {
      type: 'commit'
      operationId: string
      channelId: string
    }
  | {
      type: 'leave_observed'
      operationId: string
    }

export function voiceIntentActionFromGatewayEvent(
  event: GatewayServerEvent,
  localUserId: string | null,
): VoiceIntentGatewayAction | null {
  if (!localUserId) return null

  if (event.type === 'VoiceChannelJoin') {
    return selfVoiceCommitAction(event, localUserId, voiceJoinChannelId(event))
  }

  if (event.type === 'VoiceChannelMove') {
    return selfVoiceCommitAction(
      event,
      localUserId,
      typeof event.to === 'string' ? event.to : null,
    )
  }

  if (event.type === 'VoiceChannelLeave') {
    if (voiceEventUserId(event) !== localUserId) return null
    const operationId = voiceEventOperationId(event)
    if (!operationId) return null
    return {
      type: 'leave_observed',
      operationId,
    }
  }

  return null
}

function selfVoiceCommitAction(
  event: GatewayServerEvent,
  localUserId: string,
  channelId: string | null,
): VoiceIntentGatewayAction | null {
  const operationId = voiceEventOperationId(event)
  if (!channelId || !operationId) return null
  if (voiceEventUserId(event) !== localUserId) return null
  return {
    type: 'commit',
    channelId,
    operationId,
  }
}

function voiceJoinChannelId(event: GatewayServerEvent) {
  if (typeof event.channel === 'string') return event.channel
  if (typeof event.channel_id === 'string') return event.channel_id
  if (typeof event.id === 'string') return event.id
  return null
}

function voiceEventUserId(event: GatewayServerEvent) {
  if (typeof event.user === 'string') return event.user
  if (typeof event.user_id === 'string') return event.user_id
  if (typeof event.state?.id === 'string') return event.state.id
  if (typeof event.state?.user === 'string') return event.state.user
  if (typeof event.state?.user_id === 'string') return event.state.user_id
  return null
}

function voiceEventOperationId(event: GatewayServerEvent) {
  if (typeof event.operation_id === 'string') return event.operation_id
  if (typeof event.operationId === 'string') return event.operationId
  return undefined
}
