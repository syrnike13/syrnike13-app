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

export type DesktopOverlayState = {
  available: boolean
  enabled: boolean
  visible: boolean
  target: DesktopOverlayGameTarget | null
  snapshot: DesktopOverlaySnapshot
}

export const DESKTOP_OVERLAY_MAX_PARTICIPANTS = 8
export const DESKTOP_OVERLAY_MAX_CHANNEL_ID_LENGTH = 128
export const DESKTOP_OVERLAY_MAX_CHANNEL_LABEL_LENGTH = 120
export const DESKTOP_OVERLAY_MAX_USER_ID_LENGTH = 128
export const DESKTOP_OVERLAY_MAX_DISPLAY_NAME_LENGTH = 80
export const DESKTOP_OVERLAY_MAX_AVATAR_URL_LENGTH = 2_048

export const EMPTY_DESKTOP_OVERLAY_SNAPSHOT: DesktopOverlaySnapshot = {
  active: false,
  channelId: null,
  channelLabel: null,
  participants: [],
}

export function normalizeDesktopOverlaySnapshot(
  value: unknown,
): DesktopOverlaySnapshot {
  if (!value || typeof value !== 'object') {
    return EMPTY_DESKTOP_OVERLAY_SNAPSHOT
  }

  const snapshot = value as Partial<DesktopOverlaySnapshot>
  const active = snapshot.active === true
  const channelId = cappedStringOrNull(
    snapshot.channelId,
    DESKTOP_OVERLAY_MAX_CHANNEL_ID_LENGTH,
  )
  const channelLabel = cappedStringOrNull(
    snapshot.channelLabel,
    DESKTOP_OVERLAY_MAX_CHANNEL_LABEL_LENGTH,
  )

  if (!active || !channelId || !channelLabel) {
    return EMPTY_DESKTOP_OVERLAY_SNAPSHOT
  }

  const participants = Array.isArray(snapshot.participants)
    ? snapshot.participants
        .slice(0, DESKTOP_OVERLAY_MAX_PARTICIPANTS)
        .flatMap(normalizeDesktopOverlayParticipant)
    : []

  if (participants.length === 0) return EMPTY_DESKTOP_OVERLAY_SNAPSHOT

  return {
    active: true,
    channelId,
    channelLabel,
    participants,
  }
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
      userId: participant.userId.slice(0, DESKTOP_OVERLAY_MAX_USER_ID_LENGTH),
      displayName: participant.displayName.slice(
        0,
        DESKTOP_OVERLAY_MAX_DISPLAY_NAME_LENGTH,
      ),
      avatarUrl: cappedStringOrNull(
        participant.avatarUrl,
        DESKTOP_OVERLAY_MAX_AVATAR_URL_LENGTH,
      ),
      speaking: participant.speaking,
      muted: participant.muted,
      deafened: participant.deafened,
    },
  ]
}

export function desktopOverlaySnapshotsEqual(
  left: DesktopOverlaySnapshot,
  right: DesktopOverlaySnapshot,
) {
  if (
    left === right ||
    (left.active === right.active &&
      left.channelId === right.channelId &&
      left.channelLabel === right.channelLabel &&
      left.participants === right.participants)
  ) {
    return true
  }
  if (
    left.active !== right.active ||
    left.channelId !== right.channelId ||
    left.channelLabel !== right.channelLabel ||
    left.participants.length !== right.participants.length
  ) {
    return false
  }

  return left.participants.every((participant, index) => {
    const other = right.participants[index]
    return (
      participant.userId === other.userId &&
      participant.displayName === other.displayName &&
      participant.avatarUrl === other.avatarUrl &&
      participant.speaking === other.speaking &&
      participant.muted === other.muted &&
      participant.deafened === other.deafened
    )
  })
}

function cappedStringOrNull(value: unknown, maxLength: number) {
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, maxLength)
    : null
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
