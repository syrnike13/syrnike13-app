import type { GatewayServerEvent } from '#/features/sync/types'

export type VoiceServerCommit = {
  channelId: string
  operationId?: string
}

export function voiceCommitFromGatewayEvent(
  event: GatewayServerEvent,
  localUserId: string | null | undefined,
): VoiceServerCommit | null {
  if (!localUserId) return null

  if (event.type === 'VoiceChannelJoin') {
    const channelId = voiceJoinChannelId(event)
    const userId = voiceEventUserId(event)
    if (channelId && userId === localUserId) {
      return { channelId, operationId: voiceEventOperationId(event) }
    }
  }

  if (event.type === 'VoiceChannelMove') {
    const channelId = typeof event.to === 'string' ? event.to : null
    const userId = voiceEventUserId(event)
    if (channelId && userId === localUserId) {
      return { channelId, operationId: voiceEventOperationId(event) }
    }
  }

  return null
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
