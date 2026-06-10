export type DesktopOverlayParticipant = {
  userId: string
  displayName: string
  avatarUrl: string | null
  speaking: boolean
  muted: boolean
  deafened: boolean
}

export type DesktopOverlaySnapshot = {
  active: boolean
  channelId: string | null
  channelLabel: string | null
  participants: DesktopOverlayParticipant[]
}

export type DesktopOverlayBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type DesktopOverlayGameTarget = {
  gameId: string
  processName: string
  processPath: string | null
  title: string
  bounds: DesktopOverlayBounds
}

export type DesktopOverlayGamePreference = {
  id: string
  processName: string
  processPath: string | null
  title: string
  enabled: boolean
  lastSeenAt: number
}

export type DesktopOverlayPreferences = {
  enabled: boolean
  games: DesktopOverlayGamePreference[]
}

export type DesktopOverlayState = {
  available: boolean
  enabled: boolean
  visible: boolean
  target: DesktopOverlayGameTarget | null
  snapshot: DesktopOverlaySnapshot
}

export const EMPTY_DESKTOP_OVERLAY_SNAPSHOT: DesktopOverlaySnapshot = {
  active: false,
  channelId: null,
  channelLabel: null,
  participants: [],
}

export const DEFAULT_DESKTOP_OVERLAY_PREFERENCES: DesktopOverlayPreferences = {
  enabled: true,
  games: [],
}

export function normalizeDesktopOverlaySnapshot(
  value: unknown,
): DesktopOverlaySnapshot {
  if (!value || typeof value !== 'object') {
    return EMPTY_DESKTOP_OVERLAY_SNAPSHOT
  }

  const snapshot = value as Partial<DesktopOverlaySnapshot>
  const active = snapshot.active === true
  const channelId = stringOrNull(snapshot.channelId)
  const channelLabel = stringOrNull(snapshot.channelLabel)

  if (!active || !channelId || !channelLabel) {
    return EMPTY_DESKTOP_OVERLAY_SNAPSHOT
  }

  const participants = Array.isArray(snapshot.participants)
    ? snapshot.participants.flatMap(normalizeDesktopOverlayParticipant)
    : []

  if (participants.length === 0) return EMPTY_DESKTOP_OVERLAY_SNAPSHOT

  return {
    active: true,
    channelId,
    channelLabel,
    participants,
  }
}

export function normalizeDesktopOverlayPreferences(
  value: unknown,
): DesktopOverlayPreferences {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_DESKTOP_OVERLAY_PREFERENCES }
  }

  const preferences = value as Partial<DesktopOverlayPreferences>
  return {
    enabled:
      typeof preferences.enabled === 'boolean'
        ? preferences.enabled
        : DEFAULT_DESKTOP_OVERLAY_PREFERENCES.enabled,
    games: Array.isArray(preferences.games)
      ? preferences.games.flatMap(normalizeDesktopOverlayGamePreference)
      : [],
  }
}

function normalizeDesktopOverlayGamePreference(
  value: unknown,
): DesktopOverlayGamePreference[] {
  if (!value || typeof value !== 'object') return []

  const game = value as Partial<DesktopOverlayGamePreference>
  if (
    !nonEmptyString(game.id) ||
    !nonEmptyString(game.processName) ||
    !nonEmptyString(game.title) ||
    typeof game.enabled !== 'boolean' ||
    typeof game.lastSeenAt !== 'number' ||
    !Number.isFinite(game.lastSeenAt)
  ) {
    return []
  }

  return [
    {
      id: game.id,
      processName: game.processName,
      processPath: stringOrNull(game.processPath),
      title: game.title,
      enabled: game.enabled,
      lastSeenAt: game.lastSeenAt,
    },
  ]
}

function normalizeDesktopOverlayParticipant(
  value: unknown,
): DesktopOverlayParticipant[] {
  if (!value || typeof value !== 'object') return []

  const participant = value as Partial<DesktopOverlayParticipant>
  if (
    !nonEmptyString(participant.userId) ||
    !nonEmptyString(participant.displayName) ||
    typeof participant.speaking !== 'boolean' ||
    typeof participant.muted !== 'boolean' ||
    typeof participant.deafened !== 'boolean'
  ) {
    return []
  }

  return [
    {
      userId: participant.userId,
      displayName: participant.displayName,
      avatarUrl: stringOrNull(participant.avatarUrl),
      speaking: participant.speaking,
      muted: participant.muted,
      deafened: participant.deafened,
    },
  ]
}

function stringOrNull(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
