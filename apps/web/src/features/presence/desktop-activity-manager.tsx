import { useEffect } from 'react'
import {
  normalizeActivity,
  type Activity,
  type ActivityPatch,
  type DesktopOverlayGameTarget,
  type DesktopOverlayState,
  type MusicPresencePatch,
} from '@syrnike13/platform'

import { useAuth } from '#/features/auth/auth-context'
import { eventsGateway } from '#/features/events/gateway'
import { syncStore } from '#/features/sync/sync-store'
import { usePlatform } from '#/platform/use-platform'

export const DESKTOP_MUSIC_ACTIVITY_SOURCE_ID = 'desktop:music'
export const DESKTOP_GAME_ACTIVITY_SOURCE_ID = 'desktop:game'
const DESKTOP_ACTIVITY_HEARTBEAT_INTERVAL_MS = 30_000
const SPOTIFY_TRACK_URI_PATTERN = /^spotify:track:([A-Za-z0-9]{22})$/

const VERIFIED_DESKTOP_GAMES_BY_PROCESS_NAME: Record<
  string,
  { id: string; name?: string }
> = {
  'cs2.exe': { id: 'steam:730', name: 'Counter-Strike 2' },
  'dota2.exe': { id: 'steam:570', name: 'Dota 2' },
  'valorant-win64-shipping.exe': { id: 'riot:valorant', name: 'VALORANT' },
  'league of legends.exe': {
    id: 'riot:league-of-legends',
    name: 'League of Legends',
  },
}

export function DesktopActivityManager() {
  const auth = useAuth()
  const { desktop } = usePlatform()

  useEffect(() => {
    const userId = auth.user?._id
    if (!userId || !desktop) return

    const currentUserId = userId
    let cancelled = false
    let receivedLiveMusic = false
    let receivedLiveGame = false
    const latestActivities = new Map<string, ActivityPatch>()

    function publishActivity(activity: ActivityPatch, activitySourceId: string) {
      latestActivities.set(activitySourceId, activity)
      syncStore.setUserActivity(currentUserId, activity, activitySourceId)
      eventsGateway.activity(activity, activitySourceId)
    }

    function publishMusic(presence: MusicPresencePatch) {
      publishActivity(
        musicPresenceToActivity(presence),
        DESKTOP_MUSIC_ACTIVITY_SOURCE_ID,
      )
    }

    function publishGame(state: DesktopOverlayState) {
      publishActivity(
        overlayGameStateToActivity(state),
        DESKTOP_GAME_ACTIVITY_SOURCE_ID,
      )
    }

    void desktop.music
      .getCurrentPresence()
      .then((presence) => {
        if (!cancelled && !receivedLiveMusic) publishMusic(presence)
      })
      .catch(() => {})

    const unsubscribeMusic = desktop.music.onPresenceChange((presence) => {
      receivedLiveMusic = true
      publishMusic(presence)
    })

    void desktop.overlay
      .getState()
      .then((state) => {
        if (!cancelled && !receivedLiveGame) publishGame(state)
      })
      .catch(() => {})

    const unsubscribeOverlay = desktop.overlay.onStateChange((state) => {
      receivedLiveGame = true
      publishGame(state)
    })

    const heartbeat = window.setInterval(() => {
      for (const [activitySourceId, activity] of latestActivities) {
        if (!activity) continue
        publishActivity(refreshActivityObservedAt(activity), activitySourceId)
      }
    }, DESKTOP_ACTIVITY_HEARTBEAT_INTERVAL_MS)

    return () => {
      cancelled = true
      window.clearInterval(heartbeat)
      unsubscribeMusic()
      unsubscribeOverlay()
      publishActivity(null, DESKTOP_MUSIC_ACTIVITY_SOURCE_ID)
      publishActivity(null, DESKTOP_GAME_ACTIVITY_SOURCE_ID)
    }
  }, [auth.user?._id, desktop])

  return null
}

function refreshActivityObservedAt(activity: Activity): Activity {
  return {
    ...activity,
    observedAt: Date.now(),
  }
}

export function musicPresenceToActivity(
  presence: MusicPresencePatch,
): ActivityPatch {
  if (!presence?.isPlaying) return null

  const artists = presence.artists.join(', ')
  const timestamps = musicTimestamps(presence)
  return normalizeActivity({
    activitySourceId: DESKTOP_MUSIC_ACTIVITY_SOURCE_ID,
    type: 'listening',
    name: musicProviderLabel(presence.provider),
    details: presence.title,
    state: artists || presence.album,
    url: musicExternalUrl(presence),
    observedAt: presence.observedAt,
    timestamps,
    assets: {
      largeImageUrl: presence.artworkUrl,
      largeText: presence.album,
    },
    statusDisplayType: 'details',
  })
}

function musicExternalUrl(presence: NonNullable<MusicPresencePatch>) {
  if (presence.provider !== 'spotify') return presence.externalUrl

  const match = presence.externalUrl?.match(SPOTIFY_TRACK_URI_PATTERN)
  if (!match) return presence.externalUrl

  return `https://open.spotify.com/track/${match[1]}`
}

export function overlayGameStateToActivity(
  state: DesktopOverlayState,
): ActivityPatch {
  if (!state.target) return null
  return overlayGameTargetToActivity(state.target, Date.now())
}

export function overlayGameTargetToActivity(
  target: DesktopOverlayGameTarget,
  observedAt: number,
): Activity {
  const verifiedGame = verifiedDesktopGame(target)
  const activity = normalizeActivity({
    activitySourceId: DESKTOP_GAME_ACTIVITY_SOURCE_ID,
    type: 'playing',
    name: verifiedGame?.name ?? gameDisplayName(target),
    applicationId: verifiedGame?.id,
    observedAt,
  })

  if (!activity) {
    throw new Error('Overlay game target must produce a valid activity')
  }

  return activity
}

function musicTimestamps(presence: NonNullable<MusicPresencePatch>) {
  const progressMs =
    typeof presence.progressMs === 'number' && Number.isFinite(presence.progressMs)
      ? Math.max(0, Math.round(presence.progressMs))
      : undefined
  const durationMs =
    typeof presence.durationMs === 'number' && Number.isFinite(presence.durationMs)
      ? Math.max(0, Math.round(presence.durationMs))
      : undefined

  if (progressMs === undefined && durationMs === undefined) return undefined

  const start =
    progressMs === undefined
      ? undefined
      : Math.max(0, Math.round(presence.observedAt) - progressMs)

  return {
    start,
    end:
      start !== undefined && durationMs !== undefined
        ? start + durationMs
        : undefined,
  }
}

function musicProviderLabel(provider: NonNullable<MusicPresencePatch>['provider']) {
  switch (provider) {
    case 'spotify':
      return 'Spotify'
    case 'apple_music':
      return 'Apple Music'
    case 'yandex_music':
      return 'Yandex Music'
  }
}

function gameDisplayName(target: DesktopOverlayGameTarget) {
  const title = target.title.trim()
  if (title) return title
  return target.processName.replace(/\.exe$/i, '').trim() || target.processName
}

function verifiedDesktopGame(target: DesktopOverlayGameTarget) {
  return VERIFIED_DESKTOP_GAMES_BY_PROCESS_NAME[
    target.processName.trim().toLowerCase()
  ]
}
