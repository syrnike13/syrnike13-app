import type { GatewayServerEvent } from '#/features/sync/types'

import type { SoundEventId } from './sound-events'

export type SoundEventContext = {
  currentUserId?: string | null
  activeChannelId?: string | null
  documentFocused: boolean
  blockedUserIds: ReadonlySet<string>
}

function eventUserId(event: GatewayServerEvent) {
  if (typeof event.user === 'string') return event.user
  if (typeof event.user_id === 'string') return event.user_id
  if (typeof event.state?.id === 'string') return event.state.id
  if (typeof event.state?.user === 'string') return event.state.user
  if (typeof event.state?.user_id === 'string') return event.state.user_id
  return null
}

function messageMentionsCurrentUser(
  event: GatewayServerEvent,
  currentUserId: string | null | undefined,
) {
  if (!currentUserId || typeof event.content !== 'string') return false
  return (
    event.content.includes(`<@${currentUserId}>`) ||
    event.content.includes(`<@!${currentUserId}>`) ||
    event.content.includes('@everyone') ||
    event.content.includes('@here')
  )
}

function focusedActiveMessage(event: GatewayServerEvent, context: SoundEventContext) {
  return (
    context.documentFocused &&
    typeof event.channel === 'string' &&
    event.channel === context.activeChannelId
  )
}

function voiceStateFlagChanged(
  event: GatewayServerEvent,
  flag: 'screensharing' | 'camera',
) {
  const current = Boolean(event.state?.[flag])
  const previous =
    typeof event.previous_state === 'object' && event.previous_state
      ? Boolean((event.previous_state as Record<string, unknown>)[flag])
      : false
  if (current === previous) return null
  return current
}

export function soundEventFromGatewayEvent(
  event: GatewayServerEvent,
  context: SoundEventContext,
): SoundEventId | null {
  switch (event.type) {
    case 'Message': {
      const authorId = typeof event.author === 'string' ? event.author : null
      if (!authorId || authorId === context.currentUserId) return null
      if (context.blockedUserIds.has(authorId)) return null
      if (focusedActiveMessage(event, context)) return null
      return messageMentionsCurrentUser(event, context.currentUserId)
        ? 'message.mention'
        : 'message.default'
    }
    case 'MessageReact': {
      return event.user_id === context.currentUserId ? null : 'message.reaction'
    }
    case 'VoiceCallRinging': {
      if (event.initiator_id === context.currentUserId) return 'call.outgoing_ring'
      const recipients = Array.isArray(event.recipients) ? event.recipients : []
      return recipients.includes(context.currentUserId)
        ? 'call.incoming_ring'
        : null
    }
    case 'VoiceCallActive':
      return 'call.connected'
    case 'VoiceCallEnd':
      return 'call.ended'
    case 'VoiceChannelJoin':
      return eventUserId(event) === context.currentUserId ? null : 'voice.user_join'
    case 'VoiceChannelLeave':
      return eventUserId(event) === context.currentUserId ? null : 'voice.user_leave'
    case 'VoiceChannelMove':
      return eventUserId(event) === context.currentUserId ? null : 'voice.user_move'
    case 'VoiceStateUpdate': {
      if (eventUserId(event) === context.currentUserId) return null
      const screenShare = voiceStateFlagChanged(event, 'screensharing')
      if (screenShare != null) {
        return screenShare ? 'screen_share.started' : 'screen_share.stopped'
      }
      const camera = voiceStateFlagChanged(event, 'camera')
      if (camera != null) return camera ? 'camera.started' : 'camera.stopped'
      return null
    }
    default:
      return null
  }
}
