import { useEffect, useState } from 'react'
import type { MusicPresence, MusicProviderId } from '@syrnike13/platform'

import { ExternalLinkIcon, HeadphonesIcon } from '#/components/icons'
import { FxImage } from '#/components/ui/fx-image'
import { useSyncStore } from '#/features/sync/sync-store'
import { cn } from '#/lib/utils'

type UserMusicPresenceCardProps = {
  userId: string
  className?: string
}

const providerLabel: Record<MusicProviderId, string> = {
  spotify: 'Spotify',
  apple_music: 'Apple Music',
  yandex_music: 'Яндекс Музыка',
}

function formatTrackTime(ms: number | undefined) {
  if (ms === undefined || !Number.isFinite(ms)) return null
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

function currentProgress(presence: MusicPresence, now = Date.now()) {
  const duration = presence.durationMs
  const progress = presence.progressMs
  if (!duration || progress === undefined) return undefined

  const elapsed = presence.isPlaying
    ? Math.max(0, now - presence.observedAt)
    : 0
  return Math.min(duration, Math.max(0, progress + elapsed))
}

function safeHttpUrl(externalUrl: string) {
  try {
    const url = new URL(externalUrl)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.href
      : null
  } catch {
    return null
  }
}

function spotifyAppUrl(externalUrl: string) {
  if (externalUrl.startsWith('spotify:track:')) return externalUrl
  const safeUrl = safeHttpUrl(externalUrl)
  if (!safeUrl) return null

  try {
    const url = new URL(safeUrl)
    if (url.hostname !== 'open.spotify.com') return safeUrl
    const [, kind, id] = url.pathname.split('/')
    if (kind !== 'track' || !id) return safeUrl
    return `spotify:track:${id}`
  } catch {
    return null
  }
}

function providerOpenUrl(presence: MusicPresence) {
  const externalUrl = presence.externalUrl?.trim()
  if (!externalUrl) return null
  return presence.provider === 'spotify'
    ? spotifyAppUrl(externalUrl)
    : safeHttpUrl(externalUrl)
}

function useLiveNow(presence: MusicPresence | null) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    setNow(Date.now())
    if (
      !presence ||
      !presence.isPlaying ||
      !presence.durationMs ||
      presence.progressMs === undefined
    ) {
      return
    }

    const timer = window.setInterval(() => {
      setNow(Date.now())
    }, 1000)

    return () => {
      window.clearInterval(timer)
    }
  }, [
    presence?.durationMs,
    presence?.isPlaying,
    presence?.observedAt,
    presence?.progressMs,
  ])

  return now
}

export function UserMusicPresenceCard({
  userId,
  className,
}: UserMusicPresenceCardProps) {
  const presence = useSyncStore((s) => s.musicPresences[userId])
  const now = useLiveNow(presence ?? null)
  if (!presence) return null

  const provider = providerLabel[presence.provider]
  const progress = currentProgress(presence, now)
  const progressPercent =
    progress !== undefined && presence.durationMs
      ? Math.min(100, Math.max(0, (progress / presence.durationMs) * 100))
      : undefined
  const progressLabel = formatTrackTime(progress)
  const durationLabel = formatTrackTime(presence.durationMs)
  const openUrl = providerOpenUrl(presence)
  const artistsLabel = presence.artists.join(', ')

  return (
    <section
      className={cn(
        'rounded-lg bg-background/60 p-3 text-foreground shadow-sm ring-1 ring-border/40',
        className,
      )}
      aria-label={`Слушает ${provider}`}
    >
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <p className="truncate text-[11px] font-semibold text-muted-foreground">
          Слушает {provider}
        </p>
        {openUrl ? (
          <a
            href={openUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <ExternalLinkIcon className="size-3" />
            Открыть
          </a>
        ) : null}
      </div>

      <div className="grid min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] gap-2.5">
        <div className="relative grid size-14 shrink-0 place-items-center overflow-hidden rounded-md bg-muted text-muted-foreground">
          {presence.artworkUrl ? (
            <FxImage
              src={presence.artworkUrl}
              alt=""
              fill
              rounded="md"
              wrapperClassName="relative size-full"
            />
          ) : (
            <HeadphonesIcon className="size-6" />
          )}
        </div>

        <div className="min-w-0 self-center">
          <p
            className="line-clamp-2 text-sm font-semibold leading-snug"
            title={presence.title}
          >
            {presence.title}
          </p>
          <p
            className="mt-1 truncate text-xs leading-none text-muted-foreground"
            title={artistsLabel}
          >
            {artistsLabel}
          </p>
        </div>
      </div>

      {progressPercent !== undefined ? (
        <div className="mt-2.5 grid grid-cols-[2.25rem_minmax(0,1fr)_2.25rem] items-center gap-2 text-[11px] font-medium tabular-nums text-muted-foreground">
          <span>{progressLabel}</span>
          <div
            aria-label="Прогресс трека"
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={Math.round(progressPercent)}
            className="h-1 overflow-hidden rounded-full bg-muted"
            role="progressbar"
          >
            <div
              className="h-full rounded-full bg-foreground/70"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <span className="text-right">{durationLabel}</span>
        </div>
      ) : null}
    </section>
  )
}
