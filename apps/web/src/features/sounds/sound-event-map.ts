import type { GatewayServerEvent } from '#/features/sync/types'

import type { SoundEventId } from './sound-events'

export type SoundVoiceMediaState = {
  screensharing: boolean
  camera: boolean
}

export type SoundEventContext = {
  currentUserId?: string | null
  activeChannelId?: string | null
  currentVoiceChannelId?: string | null
  previousVoiceState?: SoundVoiceMediaState | null
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

function voiceJoinLeaveChannelId(event: GatewayServerEvent) {
  if (typeof event.channel === 'string') return event.channel
  if (typeof event.channel_id === 'string') return event.channel_id
  if (typeof event.id === 'string') return event.id
  return null
}

function voiceEventTouchesCurrentChannel(
  event: GatewayServerEvent,
  context: SoundEventContext,
) {
  const currentVoiceChannelId = context.currentVoiceChannelId
  if (!currentVoiceChannelId) return false
  if (event.type === 'VoiceChannelMove') {
    return event.from === currentVoiceChannelId || event.to === currentVoiceChannelId
  }
  return voiceJoinLeaveChannelId(event) === currentVoiceChannelId
}

function voiceStateFlagChanged(
  event: GatewayServerEvent,
  flag: 'screensharing' | 'camera',
  previousVoiceState?: SoundVoiceMediaState | null,
) {
  if (!event.state || !(flag in event.state)) return null
  const current = Boolean(event.state?.[flag])
  let previous: boolean
  if (typeof event.previous_state === 'object' && event.previous_state) {
    previous = Boolean(Reflect.get(event.previous_state, flag))
  } else if (previousVoiceState) {
    previous = previousVoiceState[flag]
  } else {
    return null
  }
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
    case 'VoiceCallActive': {
      const declinedRecipients = Array.isArray(event.declined_recipients)
        ? event.declined_recipients
        : []
      if (declinedRecipients.includes(context.currentUserId)) return null
      return event.channel_id === context.currentVoiceChannelId
        ? 'call.connected'
        : null
    }
    case 'VoiceCallEnd':
      return event.channel_id === context.currentVoiceChannelId
        ? 'call.ended'
        : null
    case 'VoiceChannelJoin':
      return eventUserId(event) === context.currentUserId ||
        !voiceEventTouchesCurrentChannel(event, context)
        ? null
        : 'voice.user_join'
    case 'VoiceChannelLeave':
      return eventUserId(event) === context.currentUserId ||
        !voiceEventTouchesCurrentChannel(event, context)
        ? null
        : 'voice.user_leave'
    case 'VoiceChannelMove':
      return eventUserId(event) === context.currentUserId ||
        !voiceEventTouchesCurrentChannel(event, context)
        ? null
        : 'voice.user_move'
    case 'VoiceStateUpdate': {
      if (
        !context.currentVoiceChannelId ||
        event.channel_id !== context.currentVoiceChannelId
      ) {
        return null
      }
      if (eventUserId(event) === context.currentUserId) return null
      const screenShare = voiceStateFlagChanged(
        event,
        'screensharing',
        context.previousVoiceState,
      )
      if (screenShare != null) {
        return screenShare ? 'screen_share.started' : 'screen_share.stopped'
      }
      const camera = voiceStateFlagChanged(
        event,
        'camera',
        context.previousVoiceState,
      )
      if (camera != null) return camera ? 'camera.started' : 'camera.stopped'
      return null
    }
    default:
      return null
  }
}
