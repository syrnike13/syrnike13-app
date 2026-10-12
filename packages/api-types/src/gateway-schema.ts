import { Schema, Struct } from 'effect'

import * as Api from './effect-schema'

type MutableJson<T> = T extends ReadonlyArray<infer Item>
  ? Array<MutableJson<Item>>
  : T extends object
    ? { -readonly [Key in keyof T]: MutableJson<T[Key]> }
    : T

function mutableJsonSchema<
  Source extends Schema.ConstraintDecoder<unknown, never>,
>(source: Source) {
  const isSource = Schema.is(source)
  return Schema.declare<MutableJson<Source['Type']>>(
    (input): input is MutableJson<Source['Type']> => isSource(input),
  )
}

const Timestamp = Schema.Union([Schema.String, Schema.Number])
const VoiceFlag = Schema.Union([Schema.Boolean, Schema.Number, Schema.String])

export const UserVoiceState = Schema.Struct({
  id: Schema.String,
  joined_at: Timestamp,
  self_mute: VoiceFlag,
  self_deaf: VoiceFlag,
  server_muted: VoiceFlag,
  server_deafened: VoiceFlag,
  screensharing: VoiceFlag,
  camera: VoiceFlag,
  version: Schema.Union([Schema.Number, Schema.String]),
})
export type UserVoiceState = typeof UserVoiceState.Type

export const ChannelVoiceState = Schema.Struct({
  id: Schema.String,
  participants: Schema.Array(UserVoiceState),
})
export type ChannelVoiceState = typeof ChannelVoiceState.Type

export const VoiceCall = Schema.Struct({
  channel_id: Schema.String,
  initiator_id: Schema.String,
  phase: Schema.Literals(['Ringing', 'Active', 'ringing', 'active']),
  started_at: Timestamp,
  expires_at: Schema.optionalKey(Timestamp),
  recipients: Schema.Array(Schema.String),
  declined_recipients: Schema.Array(Schema.String),
})
export type VoiceCall = typeof VoiceCall.Type

export const AuthorizationSnapshot = Schema.Struct({
  revision: Schema.Number,
  global: Schema.Number,
  servers: Schema.Record(Schema.String, Schema.Number),
  channels: Schema.Record(Schema.String, Schema.Number),
  users: Schema.Record(Schema.String, Schema.Number),
})
export type AuthorizationSnapshot = typeof AuthorizationSnapshot.Type

const PartialMessage = Api.Message.mapFields(
  Struct.map(Schema.optionalKey),
)
const PartialServer = Api.Server.mapFields(Struct.map(Schema.optionalKey))
const PartialRole = Api.Role.mapFields(Struct.map(Schema.optionalKey))
const PartialMember = Api.Member.mapFields(Struct.map(Schema.optionalKey))
const PartialUser = Api.User.mapFields(Struct.map(Schema.optionalKey))

const PartialChannel = Schema.Struct({
  name: Schema.optionalKey(Api.Channel.members[3].fields.name),
  owner: Schema.optionalKey(Api.Channel.members[2].fields.owner),
  description: Schema.optionalKey(Api.Channel.members[3].fields.description),
  icon: Schema.optionalKey(Api.Channel.members[3].fields.icon),
  nsfw: Schema.optionalKey(Api.Channel.members[3].fields.nsfw),
  active: Schema.optionalKey(Api.Channel.members[1].fields.active),
  permissions: Schema.optionalKey(Api.Channel.members[2].fields.permissions),
  role_permissions: Schema.optionalKey(
    Api.Channel.members[3].fields.role_permissions,
  ),
  user_permissions: Schema.optionalKey(
    Api.Channel.members[3].fields.user_permissions,
  ),
  default_permissions: Schema.optionalKey(
    Api.Channel.members[3].fields.default_permissions,
  ),
  last_message_id: Schema.optionalKey(
    Api.Channel.members[3].fields.last_message_id,
  ),
  voice: Schema.optionalKey(Api.Channel.members[3].fields.voice),
  slowmode: Schema.optionalKey(Api.Channel.members[3].fields.slowmode),
})

const MessageEvent = Schema.Struct({
  type: Schema.Literal('Message'),
  ...Api.Message.fields,
})

const ChannelCreateEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('ChannelCreate'),
    ...Api.Channel.members[0].fields,
  }),
  Schema.Struct({
    type: Schema.Literal('ChannelCreate'),
    ...Api.Channel.members[1].fields,
  }),
  Schema.Struct({
    type: Schema.Literal('ChannelCreate'),
    ...Api.Channel.members[2].fields,
  }),
  Schema.Struct({
    type: Schema.Literal('ChannelCreate'),
    ...Api.Channel.members[3].fields,
  }),
])

const EmojiCreateEvent = Schema.Struct({
  type: Schema.Literal('EmojiCreate'),
  ...Api.Emoji.fields,
})

const GatewayEventItemSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('Ready'),
    users: Schema.optionalKey(Schema.Array(Api.User)),
    servers: Schema.optionalKey(Schema.Array(Api.Server)),
    channels: Schema.optionalKey(Schema.Array(Api.Channel)),
    members: Schema.optionalKey(Schema.Array(Api.Member)),
    emojis: Schema.optionalKey(Schema.Array(Api.Emoji)),
    voice_states: Schema.optionalKey(Schema.Array(ChannelVoiceState)),
    voice_calls: Schema.optionalKey(Schema.Array(VoiceCall)),
    channel_unreads: Schema.optionalKey(Schema.Array(Api.ChannelUnread)),
    authorization: Schema.optionalKey(AuthorizationSnapshot),
  }),
  Schema.Struct({
    type: Schema.Literal('AuthorizationSnapshot'),
    snapshot: AuthorizationSnapshot,
  }),
  Schema.Struct({
    type: Schema.Literal('VoiceChannelJoin'),
    id: Schema.String,
    operation_id: Schema.optionalKey(Schema.String),
    state: UserVoiceState,
  }),
  Schema.Struct({
    type: Schema.Literal('VoiceChannelLeave'),
    id: Schema.String,
    user: Schema.String,
    operation_id: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal('VoiceChannelMove'),
    user: Schema.String,
    from: Schema.String,
    to: Schema.String,
    operation_id: Schema.optionalKey(Schema.String),
    state: UserVoiceState,
  }),
  Schema.Struct({
    type: Schema.Literal('VoiceStateUpdate'),
    channel_id: Schema.String,
    state: UserVoiceState,
  }),
  Schema.Struct({
    type: Schema.Literal('VoiceCallRinging'),
    channel_id: Schema.String,
    initiator_id: Schema.String,
    started_at: Timestamp,
    expires_at: Timestamp,
    recipients: Schema.Array(Schema.String),
    declined_recipients: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal('VoiceCallActive'),
    channel_id: Schema.String,
    initiator_id: Schema.String,
    started_at: Timestamp,
    expires_at: Schema.optionalKey(Timestamp),
    declined_recipients: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal('VoiceCallEnd'),
    channel_id: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal('MessageReact'),
    id: Schema.String,
    channel_id: Schema.String,
    user_id: Schema.String,
    emoji_id: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal('MessageUnreact'),
    id: Schema.String,
    channel_id: Schema.String,
    user_id: Schema.String,
    emoji_id: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal('MessageRemoveReaction'),
    id: Schema.String,
    channel_id: Schema.String,
    emoji_id: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal('ChannelStartTyping'),
    id: Schema.String,
    user: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal('ChannelStopTyping'),
    id: Schema.String,
    user: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal('ChannelAck'),
    id: Schema.String,
    user: Schema.String,
    message_id: Schema.String,
  }),
  MessageEvent,
  Schema.Struct({
    type: Schema.Literal('MessageUpdate'),
    channel: Schema.String,
    id: Schema.String,
    data: PartialMessage,
  }),
  Schema.Struct({
    type: Schema.Literal('MessageDelete'),
    channel: Schema.String,
    id: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal('BulkMessageDelete'),
    channel: Schema.String,
    ids: Schema.Array(Schema.String),
  }),
  ChannelCreateEvent,
  Schema.Struct({
    type: Schema.Literal('ChannelUpdate'),
    id: Schema.String,
    data: PartialChannel,
    clear: Schema.optionalKey(Schema.Array(Api.FieldsChannel)),
  }),
  Schema.Struct({
    type: Schema.Literal('ChannelDelete'),
    id: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal('ChannelGroupJoin'),
    id: Schema.String,
    user: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal('ChannelGroupLeave'),
    id: Schema.String,
    user: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal('ServerCreate'),
    id: Schema.String,
    server: Api.Server,
    channels: Schema.Array(Api.Channel),
    member: Api.Member,
    emojis: Schema.Array(Api.Emoji),
    voice_states: Schema.Array(ChannelVoiceState),
  }),
  Schema.Struct({
    type: Schema.Literal('ServerUpdate'),
    id: Schema.String,
    data: PartialServer,
    clear: Schema.optionalKey(Schema.Array(Api.FieldsServer)),
  }),
  Schema.Struct({
    type: Schema.Literal('ServerDelete'),
    id: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal('ServerMemberUpdate'),
    id: Api.MemberCompositeKey,
    data: PartialMember,
    clear: Schema.optionalKey(Schema.Array(Api.FieldsMember)),
  }),
  Schema.Struct({
    type: Schema.Literal('ServerMemberJoin'),
    id: Schema.String,
    user: Schema.String,
    member: Api.Member,
  }),
  Schema.Struct({
    type: Schema.Literal('ServerMemberLeave'),
    id: Schema.String,
    user: Schema.String,
    reason: Schema.Literals(['Leave', 'Kick', 'Ban']),
  }),
  Schema.Struct({
    type: Schema.Literal('ServerRoleUpdate'),
    id: Schema.String,
    role_id: Schema.String,
    data: PartialRole,
    clear: Schema.optionalKey(Schema.Array(Api.FieldsRole)),
  }),
  Schema.Struct({
    type: Schema.Literal('ServerRoleDelete'),
    id: Schema.String,
    role_id: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal('ServerRoleRanksUpdate'),
    id: Schema.String,
    ranks: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal('UserUpdate'),
    id: Schema.String,
    data: PartialUser,
  }),
  Schema.Struct({
    type: Schema.Literal('UserRelationship'),
    id: Schema.String,
    user: Api.User,
  }),
  Schema.Struct({
    type: Schema.Literal('UserPresence'),
    id: Schema.String,
    online: Schema.Boolean,
  }),
  EmojiCreateEvent,
  Schema.Struct({
    type: Schema.Literal('EmojiDelete'),
    id: Schema.String,
  }),
])

const BulkEventSchema = Schema.Struct({
  type: Schema.Literal('Bulk'),
  v: Schema.Array(GatewayEventItemSchema),
})

export const GatewayServerEventSchema = mutableJsonSchema(
  Schema.Union([BulkEventSchema, ...GatewayEventItemSchema.members]),
)

export type GatewayServerEvent = typeof GatewayServerEventSchema.Type
