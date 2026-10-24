import type { User } from '@syrnike13/api-types'
import type { ActivityInstance } from '@syrnike13/api-types/gateway-schema'
import type {
  ActivityParticipant,
  ActivityTheme,
  ActivityUser,
  SharedState,
  JsonValue,
} from '@syrnike13/activity-sdk/protocol'
import type { ActivitySharedState } from '@syrnike13/api-types/gateway-schema'

import { userAvatarUrl } from '#/lib/media'

/** Theme tokens exposed to applications (semantic names, without `--`). */
export const ACTIVITY_THEME_TOKENS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'border',
  'input',
  'ring',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
] as const

export function readActivityTheme(root: HTMLElement): ActivityTheme {
  const computed = getComputedStyle(root)
  const tokens: Record<string, string> = {}
  for (const name of ACTIVITY_THEME_TOKENS) {
    const value = computed.getPropertyValue(`--${name}`).trim()
    if (value) tokens[name] = value
  }
  return {
    mode: root.classList.contains('dark') ? 'dark' : 'light',
    tokens,
  }
}

/** The only origin the Activity Frame talks to; null for a malformed URL. */
export function activityOrigin(activityUrl: string) {
  try {
    const url = new URL(activityUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.origin
  } catch {
    return null
  }
}

function absoluteUrl(url: string | null) {
  if (!url) return null
  try {
    return new URL(url, window.location.href).toString()
  } catch {
    return null
  }
}

export function toActivityUser(
  userId: string,
  users: Readonly<Record<string, User | undefined>>,
): ActivityUser {
  const user = users[userId]
  return {
    id: userId,
    username: user?.username ?? userId,
    displayName: user?.display_name ?? user?.username ?? userId,
    avatarUrl: absoluteUrl(userAvatarUrl(user?.avatar)),
  }
}

export function toActivityParticipants(
  instance: ActivityInstance,
  users: Readonly<Record<string, User | undefined>>,
): ActivityParticipant[] {
  return instance.participants.map((participant) => ({
    ...toActivityUser(participant.user_id, users),
    joinedAt: String(participant.joined_at),
  }))
}

export function toSharedState(state: ActivitySharedState | null): SharedState {
  if (!state) return { version: 0, data: null, updatedBy: null }
  return {
    version: state.version,
    data: (state.data ?? null) as JsonValue,
    updatedBy: state.updated_by ?? null,
  }
}

/** Scope of persistent player data: the server, or the call channel. */
export function activityDataScope(instance: ActivityInstance) {
  return instance.server_id ?? instance.channel_id
}

/** Only http(s) URLs may leave the client through `openExternalLink`. */
export function externalLinkUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.toString()
      : null
  } catch {
    return null
  }
}
