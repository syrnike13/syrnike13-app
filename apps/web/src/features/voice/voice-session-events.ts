import type { GatewayServerEvent } from '#/features/sync/types'
import type { VoiceSessionState } from '#/features/voice/voice-session-machine'

export type VoiceServerCommit = {
  channelId: string
  operationId?: string
}

export type LocalVoiceSupersede =
  | {
      type: 'joined_elsewhere'
      channelId: string
      operationId?: string
    }
  | {
      type: 'moved_elsewhere'
      channelId: string
      operationId?: string
    }
  | {
      type: 'left_current_channel'
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

export function localVoiceSupersedeFromGatewayEvent(
  event: GatewayServerEvent,
  localUserId: string | null | undefined,
  activeChannelId: string | null | undefined,
  activeOperationId: string | null | undefined,
): LocalVoiceSupersede | null {
  if (!localUserId || !activeChannelId) return null

  const commit = voiceCommitFromGatewayEvent(event, localUserId)
  if (commit) {
    if (commit.operationId && commit.operationId === activeOperationId) {
      return null
    }
    if (commit.channelId === activeChannelId) return null
    return {
      type:
        event.type === 'VoiceChannelMove'
          ? 'moved_elsewhere'
          : 'joined_elsewhere',
      channelId: commit.channelId,
      operationId: commit.operationId,
    }
  }

  if (event.type === 'VoiceChannelLeave') {
    const channelId = voiceJoinChannelId(event)
    const userId = voiceEventUserId(event)
    if (channelId === activeChannelId && userId === localUserId) {
      const operationId = voiceEventOperationId(event)
      if (operationId && activeOperationId && operationId !== activeOperationId) {
        return null
      }
      return {
        type: 'left_current_channel',
        channelId,
        operationId,
      }
    }
  }

  return null
}

export function voiceCommitOperationIdToObserve(
  state: Pick<VoiceSessionState, 'activeOperationId' | 'desired'>,
  commit: VoiceServerCommit,
): string | null {
  if (!commit.operationId) return null
  if (state.activeOperationId !== commit.operationId) return null
  if (state.desired.kind !== 'channel') return null
  if (state.desired.channelId !== commit.channelId) return null
  if (state.desired.operationId !== commit.operationId) return null
  return commit.operationId
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
