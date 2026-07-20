import type {
  ChannelActivityErrorCode,
  ChannelActivityInstance,
  ChannelActivityViewState,
} from './channel-activity-types'

export const EMBEDDED_ACTIVITY_PROTOCOL_VERSION = 1

export type EmbeddedActivityBootstrap = Readonly<{
  type: 'syrnike.activity.bootstrap'
  version: typeof EMBEDDED_ACTIVITY_PROTOCOL_VERSION
  context: Readonly<{
    applicationId: string
    instanceId: string
    channelId: string
    currentUserId: string
  }>
  snapshot: ChannelActivityInstance
  error: ChannelActivityErrorCode | null
  transport: ChannelActivityViewState['transport']
  theme: Readonly<Record<string, string>>
}>

export type EmbeddedActivityHostMessage =
  | EmbeddedActivityBootstrap
  | Readonly<{
      type: 'syrnike.activity.snapshot'
      snapshot: ChannelActivityInstance
    }>
  | Readonly<{
      type: 'syrnike.activity.theme'
      theme: Readonly<Record<string, string>>
    }>
  | Readonly<{
      type: 'syrnike.activity.error'
      error: ChannelActivityErrorCode | null
    }>
  | Readonly<{
      type: 'syrnike.activity.transport'
      transport: ChannelActivityViewState['transport']
    }>

export type EmbeddedActivityClientMessage =
  | Readonly<{ type: 'syrnike.activity.command'; command: unknown }>
  | Readonly<{ type: 'syrnike.activity.close' }>

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
  if (!value || typeof value !== 'object') return false
  const message = value as Record<string, unknown>
  return (
    message.type === 'syrnike.activity.close' ||
    (message.type === 'syrnike.activity.command' && 'command' in message)
  )
}
