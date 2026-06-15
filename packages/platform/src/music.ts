import {
  MUSIC_PROVIDER_IDS,
  type MusicPresenceSource,
  type MusicProviderId,
} from './settings'

export type MusicPresence = {
  provider: MusicProviderId
  source: MusicPresenceSource
  title: string
  artists: string[]
  album?: string
  artworkUrl?: string
  externalUrl?: string
  durationMs?: number
  progressMs?: number
  isPlaying: boolean
  observedAt: number
}

export type MusicPresencePatch = MusicPresence | null

function objectRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function providerId(value: unknown): MusicProviderId | undefined {
  return typeof value === 'string' &&
    (MUSIC_PROVIDER_IDS as readonly string[]).includes(value)
    ? (value as MusicProviderId)
    : undefined
}

function musicPresenceSource(value: unknown): MusicPresenceSource | undefined {
  return value === 'spotify_api' || value === 'desktop_now_playing'
    ? value
    : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function normalizeArtists(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const artist = nonEmptyString(entry)
    return artist ? [artist] : []
  })
}

function normalizeProgressMs(progressMs: unknown, durationMs: number | undefined) {
  const progress = finiteNumber(progressMs)
  if (progress === undefined) return undefined
  const nonNegative = Math.max(0, Math.round(progress))
  if (durationMs === undefined) return nonNegative
  return Math.min(nonNegative, durationMs)
}

function normalizeDurationMs(value: unknown) {
  const duration = finiteNumber(value)
  return duration === undefined ? undefined : Math.max(0, Math.round(duration))
}

export function normalizeMusicPresence(value: unknown): MusicPresence | null {
  const payload = objectRecord(value)
  const provider = providerId(payload.provider)
  const source = musicPresenceSource(payload.source)
  const title = nonEmptyString(payload.title)
  const observedAt = finiteNumber(payload.observedAt)

  if (!provider || !source || !title || observedAt === undefined) return null

  const durationMs = normalizeDurationMs(payload.durationMs)
  return {
    provider,
    source,
    title,
    artists: normalizeArtists(payload.artists),
    album: optionalString(payload.album),
    artworkUrl: optionalString(payload.artworkUrl),
    externalUrl: optionalString(payload.externalUrl),
    durationMs,
    progressMs: normalizeProgressMs(payload.progressMs, durationMs),
    isPlaying: payload.isPlaying === true,
    observedAt: Math.max(0, Math.round(observedAt)),
  }
}

export function normalizeMusicPresencePatch(
  value: unknown,
): MusicPresencePatch | undefined {
  if (value === null) return null
  const presence = normalizeMusicPresence(value)
  if (!presence) return undefined
  return presence.isPlaying ? presence : null
}
