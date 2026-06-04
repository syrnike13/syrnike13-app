import type {
  Channel,
  ChannelUnread,
  Emoji,
  Member,
  Message,
  Server,
  User,
} from '@syrnike13/api-types'

import type { ChannelVoiceState, VoiceParticipantsByChannel } from './voice-types'

export type GatewayServerEvent = {
  type: string
  [key: string]: unknown
}

export type ReadyPayload = {
  users?: User[]
  servers?: Server[]
  channels?: Channel[]
  members?: Member[]
  emojis?: Emoji[]
  channel_unreads?: ChannelUnread[]
  voice_states?: ChannelVoiceState[]
}

export type SyncState = {
  ready: boolean
  selectedServerId: string | null
  servers: Record<string, Server>
  channels: Record<string, Channel>
  users: Record<string, User>
  /** `${serverId}:${userId}` → member */
  members: Record<string, Member>
  emojis: Record<string, Emoji>
  /** channelId -> messageId -> message */
  messages: Record<string, Record<string, Message>>
  /** channelId -> last read message id (current user) */
  unreads: Record<string, string | null>
  /** channelId -> user ids currently typing */
  typingUsers: Record<string, string[]>
  /** channelId -> userId -> голосовое состояние */
  voiceParticipants: VoiceParticipantsByChannel
}
