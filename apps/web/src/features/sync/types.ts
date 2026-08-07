import type {
  Channel,
  Emoji,
  Member,
  Message,
  Server,
  User,
} from '@syrnike13/api-types'
import type {
  AuthorizationSnapshot as GatewayAuthorizationSnapshot,
  ChannelVoiceState as GatewayChannelVoiceState,
  GatewayServerEvent as GatewayEvent,
} from '@syrnike13/api-types/gateway-schema'

import type {
  VoiceCallsByChannel,
  VoiceParticipantsByChannel,
} from './voice-types'

export type GatewayServerEvent = GatewayEvent
export type AuthorizationSnapshot = GatewayAuthorizationSnapshot
export type ReadyPayload = Omit<
  Extract<GatewayServerEvent, { type: 'Ready' }>,
  'type'
>
export type ServerUpdateEvent = Extract<
  GatewayServerEvent,
  { type: 'ServerUpdate' }
>
export type ServerRoleUpdateEvent = Extract<
  GatewayServerEvent,
  { type: 'ServerRoleUpdate' }
>
export type ServerMemberUpdateEvent = Extract<
  GatewayServerEvent,
  { type: 'ServerMemberUpdate' }
>

export type ServerJoinBundle = {
  server: Server
  member: Member
  channels: Channel[]
  emojis?: Emoji[]
  voiceStates?: GatewayChannelVoiceState[]
}

export type GroupJoinBundle = {
  channel: Channel
  users: User[]
}

export type ChannelUnreadState = {
  lastId: string | null
  mentions: string[]
}

export type SyncState = {
  ready: boolean
  /** Backend-authoritative effective permission masks for the current user. */
  authorization: AuthorizationSnapshot
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
