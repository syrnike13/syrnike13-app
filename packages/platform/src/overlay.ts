import { Option, Schema } from 'effect'

type Mutable<Type> = Type extends ReadonlyArray<infer Item>
  ? Array<Mutable<Item>>
  : Type extends object
    ? { -readonly [Key in keyof Type]: Mutable<Type[Key]> }
    : Type

export const DesktopOverlayParticipantSchema = Schema.Struct({
  userId: Schema.String,
  displayName: Schema.String,
  avatarUrl: Schema.Union([Schema.String, Schema.Null]),
  speaking: Schema.Boolean,
  muted: Schema.Boolean,
  deafened: Schema.Boolean,
  screensharing: Schema.Boolean,
})

export type DesktopOverlayParticipant =
  Mutable<typeof DesktopOverlayParticipantSchema.Type>

export const DesktopOverlaySnapshotSchema = Schema.Struct({
  active: Schema.Boolean,
  channelId: Schema.Union([Schema.String, Schema.Null]),
  channelLabel: Schema.Union([Schema.String, Schema.Null]),
  participants: Schema.mutable(Schema.Array(DesktopOverlayParticipantSchema)),
})

export type DesktopOverlaySnapshot = Mutable<
  typeof DesktopOverlaySnapshotSchema.Type
>

export const DesktopOverlayBoundsSchema = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
})

export type DesktopOverlayBounds = Mutable<typeof DesktopOverlayBoundsSchema.Type>

export const DesktopOverlayGameTargetSchema = Schema.Struct({
  gameId: Schema.String,
  processName: Schema.String,
  processPath: Schema.Union([Schema.String, Schema.Null]),
  title: Schema.String,
  bounds: DesktopOverlayBoundsSchema,
})

export type DesktopOverlayGameTarget =
  Mutable<typeof DesktopOverlayGameTargetSchema.Type>

export const DesktopOverlayStateSchema = Schema.Struct({
  available: Schema.Boolean,
  enabled: Schema.Boolean,
  visible: Schema.Boolean,
  target: Schema.Union([DesktopOverlayGameTargetSchema, Schema.Null]),
  snapshot: DesktopOverlaySnapshotSchema,
})

export type DesktopOverlayState = Mutable<typeof DesktopOverlayStateSchema.Type>

export const DESKTOP_OVERLAY_MAX_PARTICIPANTS = 8
export const DESKTOP_OVERLAY_MAX_CHANNEL_ID_LENGTH = 128
export const DESKTOP_OVERLAY_MAX_CHANNEL_LABEL_LENGTH = 120
export const DESKTOP_OVERLAY_MAX_USER_ID_LENGTH = 128
export const DESKTOP_OVERLAY_MAX_DISPLAY_NAME_LENGTH = 80
export const DESKTOP_OVERLAY_MAX_AVATAR_URL_LENGTH = 2_048
const UnknownOverlayRecordSchema = Schema.Record(
  Schema.String,
  Schema.Unknown,
)

export const EMPTY_DESKTOP_OVERLAY_SNAPSHOT: DesktopOverlaySnapshot = {
  active: false,
  channelId: null,
  channelLabel: null,
  participants: [],
}

export function normalizeDesktopOverlaySnapshot(
  value: unknown,
): DesktopOverlaySnapshot {
  const decoded = Schema.decodeUnknownOption(UnknownOverlayRecordSchema)(value)
  if (Option.isNone(decoded)) {
    return EMPTY_DESKTOP_OVERLAY_SNAPSHOT
  }

  const snapshot = decoded.value
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
  const decoded = Schema.decodeUnknownOption(UnknownOverlayRecordSchema)(value)
  if (Option.isNone(decoded)) return []
  const participant = decoded.value
  if (
    !nonEmptyString(participant.userId) ||
    !nonEmptyString(participant.displayName) ||
    typeof participant.speaking !== 'boolean' ||
    typeof participant.muted !== 'boolean' ||
    typeof participant.deafened !== 'boolean' ||
    typeof participant.screensharing !== 'boolean'
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
      screensharing: participant.screensharing,
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
      participant.deafened === other.deafened &&
      participant.screensharing === other.screensharing
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
