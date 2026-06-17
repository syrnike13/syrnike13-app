import { useEffect, useMemo, useState } from 'react'
import type { Activity } from '@syrnike13/platform'

import {
  ExternalLinkIcon,
  Gamepad2Icon,
  HeadphonesIcon,
} from '#/components/icons'
import { FxImage } from '#/components/ui/fx-image'
import { useSyncStore } from '#/features/sync/sync-store'
import { cn } from '#/lib/utils'

const MAX_ACTIVITY_IMAGE_DATA_URL_LENGTH = 2_100_000
const SAFE_RASTER_DATA_IMAGE_URL_PATTERN =
  /^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[A-Za-z0-9+/]+={0,2}$/i

type UserActivityCardsProps = {
  userId: string
  className?: string
}

const activityTypeOrder: Record<Activity['type'], number> = {
  playing: 0,
  streaming: 1,
  listening: 2,
  watching: 3,
  competing: 4,
  custom: 5,
}

function formatTrackTime(ms: number | undefined) {
  if (ms === undefined || !Number.isFinite(ms)) return null
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

function safeHttpUrl(externalUrl: string | undefined) {
  if (!externalUrl) return null
  try {
    const url = new URL(externalUrl)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.href
      : null
  } catch {
    return null
  }
}

function safeRasterDataImageUrl(imageUrl: string | undefined) {
  if (!imageUrl || imageUrl.length > MAX_ACTIVITY_IMAGE_DATA_URL_LENGTH) {
    return null
  }
  return SAFE_RASTER_DATA_IMAGE_URL_PATTERN.test(imageUrl) ? imageUrl : null
}

function safeImageUrl(imageUrl: string | undefined) {
  return safeHttpUrl(imageUrl) ?? safeRasterDataImageUrl(imageUrl)
}

function spotifyAppUrl(externalUrl: string | undefined) {
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

const yandexMusicHosts = new Set(['music.yandex.ru', 'music.yandex.com'])
const YANDEX_MUSIC_SEARCH_URL = 'yandexmusic://search'

function yandexMusicRoutePath(url: URL) {
  return url.pathname
}

function isYandexMusicTrackRoute(path: string) {
  return (
    /^\/album\/[^/]+\/track\/[^/]+\/?$/.test(path) ||
    /^\/track\/[^/]+\/?$/.test(path)
  )
}

function yandexMusicAppUrl(externalUrl: string | undefined) {
  const safeUrl = safeHttpUrl(externalUrl)
  if (!safeUrl) return null

  try {
    const url = new URL(safeUrl)
    if (!yandexMusicHosts.has(url.hostname)) return safeUrl
    const routePath = yandexMusicRoutePath(url)
    return isYandexMusicTrackRoute(routePath)
      ? `yandexmusic://${routePath.slice(1)}${url.search}${url.hash}`
      : safeUrl
  } catch {
    return null
  }
}

function yandexMusicSearchUrl(activity: Activity) {
  const query = [activity.state, activity.details]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(' ')
  if (!query) return null
  return `${YANDEX_MUSIC_SEARCH_URL}?text=${encodeURIComponent(query)}`
}

function activityOpenUrl(activity: Activity) {
  if (activity.type === 'listening' && activity.name === 'Spotify') {
    return spotifyAppUrl(activity.url)
  }
  if (activity.type === 'listening' && activity.name === 'Yandex Music') {
    return yandexMusicAppUrl(activity.url) ?? yandexMusicSearchUrl(activity)
  }
  return safeHttpUrl(activity.url ?? activity.buttons?.[0]?.url)
}

function activityProgress(activity: Activity, now = Date.now()) {
  const start = activity.timestamps?.start
  const end = activity.timestamps?.end
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start
  ) {
    return undefined
  }

  return {
    progress: Math.min(end - start, Math.max(0, now - start)),
    duration: end - start,
  }
}

function useLiveNow(activities: Activity[]) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    setNow(Date.now())
    if (!activities.some((activity) => activityProgress(activity))) return

    const timer = window.setInterval(() => {
      setNow(Date.now())
    }, 1000)

    return () => {
      window.clearInterval(timer)
    }
  }, [activities])

  return now
}

function sortActivities(activitiesBySource: Record<string, Activity> | undefined) {
  return Object.values(activitiesBySource ?? {}).sort((left, right) => {
    const byType = activityTypeOrder[left.type] - activityTypeOrder[right.type]
    if (byType !== 0) return byType
    return left.activitySourceId.localeCompare(right.activitySourceId)
  })
}

function activityHeader(activity: Activity) {
  switch (activity.type) {
    case 'playing':
      return 'Играет'
    case 'streaming':
      return 'Стримит'
    case 'listening':
      return `Слушает ${activity.name}`
    case 'watching':
      return 'Смотрит'
    case 'competing':
      return 'Соревнуется'
    case 'custom':
      return 'Активность'
  }
}

function activityTitle(activity: Activity) {
  if (activity.type === 'listening') return activity.details ?? activity.name
  return activity.details ?? activity.name
}

function activitySubtitle(activity: Activity) {
  if (activity.type === 'listening') return activity.state
  return activity.state
}

function ActivityFallbackIcon({ type }: { type: Activity['type'] }) {
  if (type === 'playing') return <Gamepad2Icon className="size-6" />
  return <HeadphonesIcon className="size-6" />
}

function UserActivityCard({
  activity,
  now,
}: {
  activity: Activity
  now: number
}) {
  const title = activityTitle(activity)
  const subtitle = activitySubtitle(activity)
  const progress = activityProgress(activity, now)
  const progressPercent = progress
    ? Math.min(100, Math.max(0, (progress.progress / progress.duration) * 100))
    : undefined
  const openUrl = activityOpenUrl(activity)
  const artworkUrl = safeImageUrl(activity.assets?.largeImageUrl ?? undefined)

  return (
    <section
      className="rounded-lg bg-background/60 p-3 text-foreground shadow-sm ring-1 ring-border/40"
      aria-label={activityHeader(activity)}
    >
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <p className="truncate text-[11px] font-semibold text-muted-foreground">
          {activityHeader(activity)}
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
          {artworkUrl ? (
            <FxImage
              src={artworkUrl}
              alt=""
              fill
              rounded="md"
              wrapperClassName="relative size-full"
            />
          ) : (
            <ActivityFallbackIcon type={activity.type} />
          )}
        </div>

        <div className="min-w-0 self-center">
          <p
            className="line-clamp-2 text-sm font-semibold leading-snug"
            title={title}
          >
            {title}
          </p>
          {subtitle ? (
            <p
              className="mt-1 truncate text-xs leading-none text-muted-foreground"
              title={subtitle}
            >
              {subtitle}
            </p>
          ) : null}
        </div>
      </div>

      {progressPercent !== undefined ? (
        <div className="mt-2.5 grid grid-cols-[2.25rem_minmax(0,1fr)_2.25rem] items-center gap-2 text-[11px] font-medium tabular-nums text-muted-foreground">
          <span>{formatTrackTime(progress?.progress)}</span>
          <div
            aria-label="Прогресс активности"
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
          <span className="text-right">{formatTrackTime(progress?.duration)}</span>
        </div>
      ) : null}
    </section>
  )
}

export function UserActivityCards({ userId, className }: UserActivityCardsProps) {
  const activitiesBySource = useSyncStore((s) => s.activities[userId])
  const activities = useMemo(
    () => sortActivities(activitiesBySource),
    [activitiesBySource],
  )
  const now = useLiveNow(activities)

  if (activities.length === 0) return null

  return (
    <div className={cn('space-y-2', className)}>
      {activities.map((activity) => (
        <UserActivityCard
          key={activity.activitySourceId}
          activity={activity}
          now={now}
        />
      ))}
    </div>
  )
}
