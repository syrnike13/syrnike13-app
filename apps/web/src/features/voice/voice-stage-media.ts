export type StageMediaKind = 'screen' | 'camera' | 'avatar'

export function stageMediaKindLabel(kind: StageMediaKind) {
  if (kind === 'screen') return 'Экран'
  if (kind === 'camera') return 'Камера'
  return null
}

const STAGE_MEDIA_GRID_KIND_ORDER: Record<StageMediaKind, number> = {
  screen: 0,
  camera: 1,
  avatar: 2,
}

/** Демонстрации и камеры — в начале сетки стейджа, аватары без видео — в конце. */
export function sortStageMediaItemsForGrid<T extends { kind: StageMediaKind }>(
  items: readonly T[],
): T[] {
  return [...items].sort(
    (left, right) =>
      STAGE_MEDIA_GRID_KIND_ORDER[left.kind] -
      STAGE_MEDIA_GRID_KIND_ORDER[right.kind],
  )
}

export type StageMediaTrackSource = 'screen' | 'camera'

export type StageMediaParticipant = {
  id: string
}

export type StageMediaFilters = {
  showOwnStream: boolean
  showRemoteStreams: boolean
  showParticipantsWithoutMedia: boolean
}

export type StageMediaTrackEntry<TTrack = unknown, TPublication = unknown> = {
  userId: string
  source: StageMediaTrackSource
  track?: TTrack | null
  publication?: TPublication | null
  subscribed?: boolean
  live?: boolean
}

export type StageMediaItem<TTrack = unknown, TPublication = unknown> = {
  id: string
  userId: string
  kind: StageMediaKind
  source?: StageMediaTrackSource
  track?: TTrack | null
  publication?: TPublication | null
  isLocal: boolean
  subscribed?: boolean
  live: boolean
  /** Ожидание LiveKit: полупрозрачная плитка до connected. */
  pending?: boolean
}

export type BuildStageMediaItemsInput<TTrack = unknown, TPublication = unknown> = {
  participants: readonly StageMediaParticipant[]
  currentUserId: string | null
  tracks: readonly StageMediaTrackEntry<TTrack, TPublication>[]
  filters: StageMediaFilters
}

export function buildStageMediaItems<TTrack = unknown, TPublication = unknown>({
  participants,
  currentUserId,
  tracks,
  filters,
}: BuildStageMediaItemsInput<TTrack, TPublication>): StageMediaItem<
  TTrack,
  TPublication
>[] {
  const tracksByUser = new Map<
    string,
    Partial<
      Record<StageMediaTrackSource, StageMediaTrackEntry<TTrack, TPublication>>
    >
  >()

  for (const track of tracks) {
    const userTracks = tracksByUser.get(track.userId) ?? {}
    const existing = userTracks[track.source]
    userTracks[track.source] = existing
      ? selectStageMediaTrack(existing, track)
      : track
    if (existing && import.meta.env.DEV) {
      console.warn(
        `Duplicate stage media track for user ${track.userId} and source ${track.source}; keeping the most live entry.`,
      )
    }
    tracksByUser.set(track.userId, userTracks)
  }

  const items: StageMediaItem<TTrack, TPublication>[] = []

  for (const participant of participants) {
    const userId = participant.id
    const isLocal = userId === currentUserId

    if (isLocal && !filters.showOwnStream) continue
    if (!isLocal && !filters.showRemoteStreams) continue

    const userTracks = tracksByUser.get(userId)
    const screen = userTracks?.screen
    const camera = userTracks?.camera

    if (screen) {
      items.push(mediaItem(userId, 'screen', screen, isLocal))
    }

    if (camera) {
      items.push(mediaItem(userId, 'camera', camera, isLocal))
    }

    if (!camera && filters.showParticipantsWithoutMedia) {
      items.push({
        id: stageMediaItemId(userId, 'avatar'),
        userId,
        kind: 'avatar',
        isLocal,
        live: true,
      })
    }
  }

  return items
}

function selectStageMediaTrack<TTrack, TPublication>(
  current: StageMediaTrackEntry<TTrack, TPublication>,
  next: StageMediaTrackEntry<TTrack, TPublication>,
) {
  return stageMediaTrackScore(next) > stageMediaTrackScore(current)
    ? next
    : current
}

function stageMediaTrackScore<TTrack, TPublication>(
  entry: StageMediaTrackEntry<TTrack, TPublication>,
) {
  return (
    (entry.track != null ? 4 : 0) +
    (entry.live === true ? 2 : 0) +
    (entry.subscribed === true ? 1 : 0)
  )
}

function mediaItem<TTrack, TPublication>(
  userId: string,
  kind: StageMediaTrackSource,
  entry: StageMediaTrackEntry<TTrack, TPublication>,
  isLocal: boolean,
): StageMediaItem<TTrack, TPublication> {
  return {
    id: stageMediaItemId(userId, kind),
    userId,
    kind,
    source: entry.source,
    track: entry.track,
    publication: entry.publication,
    isLocal,
    subscribed: entry.subscribed,
    live: entry.live ?? Boolean(entry.track && entry.subscribed !== false),
  }
}

export function stageMediaItemId(userId: string, kind: StageMediaKind) {
  return `${userId}:${kind}`
}

export function isStageVideoMediaItem(item: { kind: StageMediaKind }) {
  return item.kind === 'screen' || item.kind === 'camera'
}

export function filterStageVideoMediaItems<T extends { kind: StageMediaKind }>(
  items: readonly T[],
): T[] {
  return items.filter(isStageVideoMediaItem)
}
