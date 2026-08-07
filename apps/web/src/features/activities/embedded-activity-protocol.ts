import { Option, Schema } from 'effect'

import {
  ChannelActivityErrorCodeSchema,
  ChannelActivityInstanceSchema,
  ChannelActivityTransportSchema,
} from './channel-activity-types'

export const EMBEDDED_ACTIVITY_PROTOCOL_VERSION = 1

const EmbeddedActivityThemeSchema = Schema.Record(
  Schema.String,
  Schema.String,
)

export const EmbeddedActivityBootstrapSchema = Schema.Struct({
  type: Schema.Literal('syrnike.activity.bootstrap'),
  version: Schema.Literal(EMBEDDED_ACTIVITY_PROTOCOL_VERSION),
  context: Schema.Struct({
    applicationId: Schema.String,
    instanceId: Schema.String,
    channelId: Schema.String,
    currentUserId: Schema.String,
  }),
  snapshot: ChannelActivityInstanceSchema,
  error: Schema.Union([ChannelActivityErrorCodeSchema, Schema.Null]),
  transport: ChannelActivityTransportSchema,
  theme: EmbeddedActivityThemeSchema,
})

export const EmbeddedActivityHostMessageSchema = Schema.Union([
  EmbeddedActivityBootstrapSchema,
  Schema.Struct({
    type: Schema.Literal('syrnike.activity.snapshot'),
    snapshot: ChannelActivityInstanceSchema,
  }),
  Schema.Struct({
    type: Schema.Literal('syrnike.activity.theme'),
    theme: EmbeddedActivityThemeSchema,
  }),
  Schema.Struct({
    type: Schema.Literal('syrnike.activity.error'),
    error: Schema.Union([ChannelActivityErrorCodeSchema, Schema.Null]),
  }),
  Schema.Struct({
    type: Schema.Literal('syrnike.activity.transport'),
    transport: ChannelActivityTransportSchema,
  }),
])

export const EmbeddedActivityClientMessageSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('syrnike.activity.command'),
    command: Schema.Unknown,
  }),
  Schema.Struct({ type: Schema.Literal('syrnike.activity.close') }),
])

export type EmbeddedActivityBootstrap =
  typeof EmbeddedActivityBootstrapSchema.Type
export type EmbeddedActivityHostMessage =
  typeof EmbeddedActivityHostMessageSchema.Type
export type EmbeddedActivityClientMessage =
  typeof EmbeddedActivityClientMessageSchema.Type

const THEME_TOKEN_KEYS = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--muted',
  '--muted-foreground',
  '--primary',
  '--primary-foreground',
  '--border',
  '--ring',
  '--destructive',
  '--destructive-foreground',
  '--chart-3',
] as const

export function readEmbeddedActivityTheme() {
  const styles = getComputedStyle(document.documentElement)
  return Object.fromEntries(
    THEME_TOKEN_KEYS.map((key) => [key, styles.getPropertyValue(key).trim()]),
  )
}

export function isEmbeddedActivityClientMessage(
  value: unknown,
): value is EmbeddedActivityClientMessage {
  return Option.isSome(
    Schema.decodeUnknownOption(EmbeddedActivityClientMessageSchema)(value),
  )
}
