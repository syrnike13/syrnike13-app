import { Option, Schema } from 'effect'

export const SHARED_COUNTER_APPLICATION_ID = 'syrnike13.shared-counter'
export const SYRNIK_RACE_APPLICATION_ID = 'syrnike13.syrnik-race'

const ChannelActivityIdentifierSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
)

const ChannelActivityGenerationSchema = Schema.Natural

export const ChannelActivityErrorCodeSchema = Schema.Literals([
  'not_in_voice_channel',
  'unknown_application',
  'already_running',
  'instance_not_found',
  'not_participant',
  'not_owner',
  'invalid_command',
  'invalid_request',
  'internal',
])

export const ChannelActivityInstanceSchema = Schema.Struct({
  id: ChannelActivityIdentifierSchema,
  generation: ChannelActivityGenerationSchema,
  application_id: ChannelActivityIdentifierSchema,
  channel_id: ChannelActivityIdentifierSchema,
  server_id: Schema.optional(ChannelActivityIdentifierSchema),
  owner_id: ChannelActivityIdentifierSchema,
  participant_ids: Schema.Array(ChannelActivityIdentifierSchema),
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  state: Schema.Unknown,
  created_at: Schema.Union([Schema.String, Schema.Number]),
  expires_at: Schema.Int.check(Schema.isGreaterThan(0)),
})

export const ChannelActivityTransportSchema = Schema.Literals([
  'connected',
  'reconnecting',
  'disconnected',
])

export const ChannelActivityViewStateSchema = Schema.Struct({
  instance: Schema.Union([ChannelActivityInstanceSchema, Schema.Null]),
  generation: ChannelActivityGenerationSchema,
  error: Schema.Union([ChannelActivityErrorCodeSchema, Schema.Null]),
  transport: ChannelActivityTransportSchema,
})

export type ChannelActivityInstance = typeof ChannelActivityInstanceSchema.Type
export type ChannelActivityErrorCode =
  typeof ChannelActivityErrorCodeSchema.Type
export type ChannelActivityViewState = typeof ChannelActivityViewStateSchema.Type

export function isChannelActivityInstance(
  value: unknown,
): value is ChannelActivityInstance {
  return Option.isSome(
    Schema.decodeUnknownOption(ChannelActivityInstanceSchema)(value),
  )
}

export function validChannelActivityGeneration(value: unknown): value is number {
  return Option.isSome(
    Schema.decodeUnknownOption(ChannelActivityGenerationSchema)(value),
  )
}

export function isChannelActivityErrorCode(
  value: unknown,
): value is ChannelActivityErrorCode {
  return Option.isSome(
    Schema.decodeUnknownOption(ChannelActivityErrorCodeSchema)(value),
  )
}
