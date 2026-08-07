import type { GatewayServerEvent } from '#/features/sync/types'

import type { SoundEventId } from './sound-events'

type MessageEvent = Extract<GatewayServerEvent, { type: 'Message' }>
type VoiceMembershipEvent = Extract<
  GatewayServerEvent,
  {
    type:
      | 'VoiceChannelJoin'
      | 'VoiceChannelLeave'
      | 'VoiceChannelMove'
      | 'VoiceStateUpdate'
  }
>
type VoiceJoinLeaveEvent = Extract<
  VoiceMembershipEvent,
  { type: 'VoiceChannelJoin' | 'VoiceChannelLeave' }
>
type VoiceStateUpdateEvent = Extract<
  GatewayServerEvent,
  { type: 'VoiceStateUpdate' }
>

export type SoundVoiceMediaState = {
  screensharing: boolean
  camera: boolean
  selfMuted?: boolean
  selfDeafened?: boolean
}

export type SoundEventContext = {
  currentUserId?: string | null
  activeChannelId?: string | null
  currentVoiceChannelId?: string | null
  previousVoiceState?: SoundVoiceMediaState | null
  documentFocused: boolean
  blockedUserIds: ReadonlySet<string>
}

function eventUserId(event: VoiceMembershipEvent) {
  switch (event.type) {
    case 'VoiceChannelLeave':
    case 'VoiceChannelMove':
      return event.user
    case 'VoiceChannelJoin':
    case 'VoiceStateUpdate':
      return event.state.id
  }
}

function messageMentionsCurrentUser(
  event: MessageEvent,
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

function focusedActiveMessage(event: MessageEvent, context: SoundEventContext) {
  return (
    context.documentFocused &&
    typeof event.channel === 'string' &&
    event.channel === context.activeChannelId
  )
}

function voiceJoinLeaveChannelId(event: VoiceJoinLeaveEvent) {
  return event.id
}

function voiceEventTouchesCurrentChannel(
  event: Extract<
    VoiceMembershipEvent,
    { type: 'VoiceChannelJoin' | 'VoiceChannelLeave' | 'VoiceChannelMove' }
  >,
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
  event: VoiceStateUpdateEvent,
  flag: 'screensharing' | 'camera',
  previousVoiceState?: SoundVoiceMediaState | null,
) {
  if (!event.state || !(flag in event.state)) return null
  const current = Boolean(event.state?.[flag])
  if (!previousVoiceState) return null
  const previous = previousVoiceState[flag]
  if (current === previous) return null
  return current
}

function selfVoiceStateFlagChanged(
  event: VoiceStateUpdateEvent,
  flag: 'self_mute' | 'self_deaf',
  previousKey: 'selfMuted' | 'selfDeafened',
  previousVoiceState?: SoundVoiceMediaState | null,
) {
  if (!event.state || !(flag in event.state)) return null
  const current = Boolean(event.state[flag])
  if (previousVoiceState?.[previousKey] == null) return null
  const previous = Boolean(previousVoiceState[previousKey])
  return current === previous ? null : current
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
      if (!context.currentUserId) return null
      return event.recipients.includes(context.currentUserId)
        ? 'call.incoming_ring'
        : null
    }
    case 'VoiceCallActive': {
      if (
        context.currentUserId &&
        event.declined_recipients.includes(context.currentUserId)
      ) {
        return null
      }
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
      if (eventUserId(event) === context.currentUserId) {
        const deafened = selfVoiceStateFlagChanged(
          event,
          'self_deaf',
          'selfDeafened',
          context.previousVoiceState,
        )
        if (deafened != null) {
          return deafened ? 'voice.deafen' : 'voice.undeafen'
        }
        const muted = selfVoiceStateFlagChanged(
          event,
          'self_mute',
          'selfMuted',
          context.previousVoiceState,
        )
        if (muted != null) return muted ? 'voice.mute' : 'voice.unmute'
        return null
      }
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
