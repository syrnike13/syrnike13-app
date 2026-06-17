import { ipcMain, type BrowserWindow } from 'electron'
import {
  IPC,
  type DesktopLocalSettings,
  type MusicPresence,
  type MusicPresencePatch,
} from '@syrnike13/platform'

import {
  getCurrentDesktopMusicPresence,
  watchDesktopMusicPresence,
} from './desktop-music-presence'

type RegisterDesktopMusicPresenceOptions = {
  getSettings: () => Pick<DesktopLocalSettings, 'music'>
  probeMusicPresence?: (
    settings: Pick<DesktopLocalSettings, 'music'>,
  ) => Promise<MusicPresencePatch>
  watchMusicPresence?: (options: {
    getSettings: () => Pick<DesktopLocalSettings, 'music'>
    onChange: (presence: MusicPresencePatch) => void
    onUnavailable: () => void
  }) => (() => void) | null
  pollIntervalMs?: number
}

const DEFAULT_MUSIC_PRESENCE_POLL_INTERVAL_MS = 1_000

export function registerDesktopMusicPresenceIpc(
  getWindow: () => BrowserWindow | null,
  options: RegisterDesktopMusicPresenceOptions,
) {
  let lastPresence: MusicPresencePatch = null
  let polling = false
  let timer: ReturnType<typeof setInterval> | undefined

  const probeMusicPresence =
    options.probeMusicPresence ??
    ((settings: Pick<DesktopLocalSettings, 'music'>) =>
      getCurrentDesktopMusicPresence({ settings }))
  const watchMusicPresence =
    options.watchMusicPresence ??
    ((watchOptions) => watchDesktopMusicPresence(watchOptions))

  function publishPresence(nextPresence: MusicPresencePatch) {
    nextPresence = withRetainedTrackMetadata(lastPresence, nextPresence)
    if (musicPresenceEquals(lastPresence, nextPresence)) return
    lastPresence = nextPresence
    getWindow()?.webContents.send(IPC.musicPresenceChanged, nextPresence)
  }

  async function readPresence() {
    try {
      return await probeMusicPresence(options.getSettings())
    } catch {
      return null
    }
  }

  async function pollPresence() {
    if (polling) return
    polling = true
    try {
      const nextPresence = await readPresence()
      publishPresence(nextPresence)
    } finally {
      polling = false
    }
  }

  function startPolling() {
    if (timer) return
    const pollIntervalMs =
      options.pollIntervalMs ?? DEFAULT_MUSIC_PRESENCE_POLL_INTERVAL_MS
    if (pollIntervalMs <= 0) return
    timer = setInterval(() => {
      void pollPresence()
    }, pollIntervalMs)
    timer.unref?.()
  }

  ipcMain.handle(IPC.musicGetCurrentPresence, async () => {
    lastPresence = await readPresence()
    return lastPresence
  })

  const disposeWatcher = watchMusicPresence({
    getSettings: options.getSettings,
    onChange: publishPresence,
    onUnavailable: startPolling,
  })
  if (!disposeWatcher) startPolling()

  return () => {
    if (timer) clearInterval(timer)
    ipcMain.removeHandler(IPC.musicGetCurrentPresence)
    disposeWatcher?.()
    lastPresence = null
  }
}

function musicPresenceEquals(
  left: MusicPresencePatch,
  right: MusicPresencePatch,
) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function withRetainedTrackMetadata(
  previous: MusicPresencePatch,
  next: MusicPresencePatch,
): MusicPresencePatch {
  if (!previous || !next || !sameMusicTrack(previous, next)) return next

  let retained = next
  if (!retained.artworkUrl && previous.artworkUrl) {
    retained = { ...retained, artworkUrl: previous.artworkUrl }
  }
  if (!retained.externalUrl && previous.externalUrl) {
    retained = { ...retained, externalUrl: previous.externalUrl }
  }

  return retained
}

function sameMusicTrack(left: MusicPresence, right: MusicPresence) {
  return (
    left.provider === right.provider &&
    left.source === right.source &&
    left.title === right.title &&
    left.album === right.album &&
    left.artists.join('\u0000') === right.artists.join('\u0000')
  )
}
