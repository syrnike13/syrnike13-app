import type {
  Channel,
  ChannelUnread,
  Emoji,
  FieldsMember,
  FieldsRole,
  FieldsServer,
  Member,
  Message,
  Role,
  Server,
  User,
} from '@syrnike13/api-types'

import type {
  ChannelVoiceState,
  UserVoiceState,
  VoiceCallsByChannel,
  VoiceParticipantsByChannel,
} from './voice-types'

export type ServerCreateEvent = {
  type: 'ServerCreate'
  id: string
  server: Server
  member: Member
  channels: Channel[]
  emojis: Emoji[]
  voice_states: ChannelVoiceState[]
}

export type ServerUpdateEvent = {
  type: 'ServerUpdate'
  id: string
  data: Partial<Server>
  clear?: FieldsServer[]
}

export type ServerRoleUpdateEvent = {
  type: 'ServerRoleUpdate'
  id: string
  role_id: string
  data: Partial<Role>
  clear?: FieldsRole[]
}

export type ServerMemberUpdateEvent = {
  type: 'ServerMemberUpdate'
  id: { server: string; user: string }
  data: Partial<Member>
  clear?: FieldsMember[]
}

export type GatewayServerEvent = {
  type?: string
  channel_id?: string
  state?: Partial<UserVoiceState> & { user?: string; user_id?: string }
  // Gateway events are raw JSON. Event-specific branches normalize the shape.
  [key: string]: any
}

export type ServerJoinBundle = {
  server: Server
  member: Member
  channels: Channel[]
  emojis?: Emoji[]
  voiceStates?: ChannelVoiceState[]
}

export type GroupJoinBundle = {
  channel: Channel
  users: User[]
}

export type ReadyPayload = {
  users?: User[]
  servers?: Server[]
  channels?: Channel[]
  members?: Member[]
  emojis?: Emoji[]
  channel_unreads?: ChannelUnread[]
  voice_states?: ChannelVoiceState[]
  voice_calls?: Array<{
    channel_id: string
    initiator_id: string
    phase: 'Ringing' | 'Active' | 'ringing' | 'active'
    started_at: number | string
    expires_at?: number | string
    recipients?: string[]
    declined_recipients?: string[]
  }>
}

export type ChannelUnreadState = {
  lastId: string | null
  mentions: string[]
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
  /** channelId -> unread state for current user */
  unreads: Record<string, ChannelUnreadState>
  /** channelId -> user ids currently typing */
  typingUsers: Record<string, string[]>
  /** channelId -> userId -> голосовое состояние */
  voiceParticipants: VoiceParticipantsByChannel
  /** channelId -> lifecycle of a DM/group voice call. */
  voiceCalls: VoiceCallsByChannel
  /** In-memory call UI keys hidden by the current client session. */
  dismissedVoiceCallKeys: Record<string, true>
}
