import { execFile, spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import {
  type DesktopLocalSettings,
  type MusicPresence,
  type MusicPresencePatch,
  type MusicProviderId,
  normalizeMusicPresence,
} from '@syrnike13/platform'

export type MusicProbeCommand = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<string>

type WindowsSpotifyTrackUriReader = (presence: MusicPresence) => string | undefined

type DesktopMusicPresenceOptions = {
  platform?: NodeJS.Platform
  settings: Pick<DesktopLocalSettings, 'music'>
  now?: () => number
  runCommand?: MusicProbeCommand
  windowsHelperPath?: string | null
  readWindowsSpotifyTrackUri?: WindowsSpotifyTrackUriReader
}

type WindowsNowPlayingPayload = {
  appUserModelId?: unknown
  title?: unknown
  artist?: unknown
  albumTitle?: unknown
  durationMs?: unknown
  positionMs?: unknown
  playbackStatus?: unknown
  artworkUrl?: unknown
  externalUrl?: unknown
  observedAt?: unknown
}

type MacNowPlayingPayload = {
  app?: unknown
  title?: unknown
  artist?: unknown
  album?: unknown
  durationSeconds?: unknown
  positionSeconds?: unknown
  playerState?: unknown
  artworkUrl?: unknown
  externalUrl?: unknown
}

type MusicPresenceWatchProcess = {
  stdout: Readable
  killed: boolean
  kill: () => boolean
  once: (
    event: 'error' | 'exit',
    listener: (...args: unknown[]) => void,
  ) => MusicPresenceWatchProcess
}

const PROBE_TIMEOUT_MS = 2_500
const PROBE_MAX_BUFFER_BYTES = 4 * 1024 * 1024
const SPOTIFY_STATE_MAX_BYTES = 64 * 1024
const WINDOWS_SPOTIFY_TRACK_URI_CACHE_TTL_MS = 1_000
const SPOTIFY_CONTEXT_STATE_FILE = 'context_player_state_restore'
const WINDOWS_MUSIC_HELPER_EXE = 'syrnike-music-presence-win.exe'
const SPOTIFY_TRACK_URI_PATTERN = /\bspotify:track:[A-Za-z0-9]{22}\b/g
const SPOTIFY_STATE_MATCH_WINDOW_CHARS = 4_096
const WINDOWS_BROWSER_APP_ID_PARTS = [
  'chrome',
  'msedge',
  'firefox',
  'brave',
  'opera',
  'yandexbrowser',
  'yandex.browser',
]

export type DesktopMusicPresenceWatcherOptions = {
  platform?: NodeJS.Platform
  getSettings: () => Pick<DesktopLocalSettings, 'music'>
  onChange: (presence: MusicPresencePatch) => void
  onUnavailable?: () => void
  now?: () => number
  spawnCommand?: (
    command: string,
    args: string[],
  ) => MusicPresenceWatchProcess
  windowsHelperPath?: string | null
  readWindowsSpotifyTrackUri?: WindowsSpotifyTrackUriReader
}

const WINDOWS_GSMTC_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and
  $_.IsGenericMethodDefinition -and
  $_.GetParameters().Count -eq 1
})[0]

function Await-WinRt($operation, $resultType) {
  $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.Wait()
  return $task.Result
}

$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$manager = Await-WinRt ($managerType::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$session = $manager.GetCurrentSession()
if ($null -eq $session) {
  'null'
  exit 0
}

$props = Await-WinRt ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
$timeline = $session.GetTimelineProperties()
$playback = $session.GetPlaybackInfo()

[pscustomobject]@{
  appUserModelId = $session.SourceAppUserModelId
  title = $props.Title
  artist = $props.Artist
  albumTitle = $props.AlbumTitle
  durationMs = [int64]$timeline.EndTime.TotalMilliseconds
  positionMs = [int64]$timeline.Position.TotalMilliseconds
  playbackStatus = $playback.PlaybackStatus.ToString()
} | ConvertTo-Json -Compress
`

const MAC_NOW_PLAYING_SCRIPT = String.raw`
function readSpotify() {
  const app = Application('Spotify')
  if (!app.running()) return null
  const state = String(app.playerState())
  if (state === 'stopped') return null
  const track = app.currentTrack()
  return {
    app: 'Spotify',
    title: track.name(),
    artist: track.artist(),
    album: track.album(),
    durationSeconds: Number(track.duration()),
    positionSeconds: Number(app.playerPosition()),
    playerState: state,
    externalUrl: track.spotifyUrl(),
  }
}

function readMusic() {
  const app = Application('Music')
  if (!app.running()) return null
  const state = String(app.playerState())
  if (state === 'stopped') return null
  const track = app.currentTrack()
  return {
    app: 'Music',
    title: track.name(),
    artist: track.artist(),
    album: track.album(),
    durationSeconds: Number(track.duration()),
    positionSeconds: Number(app.playerPosition()),
    playerState: state,
  }
}

JSON.stringify(readSpotify() || readMusic())
`

export async function getCurrentDesktopMusicPresence({
  platform = process.platform,
  settings,
  now = () => Date.now(),
  runCommand = runOsCommand,
  windowsHelperPath,
  readWindowsSpotifyTrackUri = readDefaultWindowsSpotifyTrackUri,
}: DesktopMusicPresenceOptions): Promise<MusicPresence | null> {
  if (!settings.music.enabled || !settings.music.showInProfile) return null
  if (!hasEnabledDesktopMusicProvider(settings.music.providers)) return null

  if (platform === 'win32') {
    const helperPath = windowsHelperPath ?? resolveDefaultWindowsMusicHelperPath()
    if (helperPath) {
      try {
        const output = await runCommand(helperPath, [], PROBE_TIMEOUT_MS)
        const presence = normalizeWindowsNowPlayingPayload(
          parseProbeJson(output),
          now(),
        )
        return finalizeDesktopMusicPresence(settings, presence, {
          platform,
          readWindowsSpotifyTrackUri,
        })
      } catch {
        // The C# helper gives artwork on Windows, but the PowerShell probe is
        // still useful when the helper is absent or blocked.
      }
    }

    const output = await runCommand(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        WINDOWS_GSMTC_SCRIPT,
      ],
      PROBE_TIMEOUT_MS,
    )
    const presence = normalizeWindowsNowPlayingPayload(parseProbeJson(output), now())
    return finalizeDesktopMusicPresence(settings, presence, {
      platform,
      readWindowsSpotifyTrackUri,
    })
  }

  if (platform === 'darwin') {
    const output = await runCommand(
      'osascript',
      ['-l', 'JavaScript', '-e', MAC_NOW_PLAYING_SCRIPT],
      PROBE_TIMEOUT_MS,
    )
    const presence = normalizeMacNowPlayingPayload(parseProbeJson(output), now())
    return finalizeDesktopMusicPresence(settings, presence, {
      platform,
      readWindowsSpotifyTrackUri,
    })
  }

  return null
}

export function watchDesktopMusicPresence({
  platform = process.platform,
  getSettings,
  onChange,
  onUnavailable,
  now = () => Date.now(),
  spawnCommand = runWatchCommand,
  windowsHelperPath,
  readWindowsSpotifyTrackUri = readDefaultWindowsSpotifyTrackUri,
}: DesktopMusicPresenceWatcherOptions): (() => void) | null {
  if (platform !== 'win32') return null

  const helperPath = windowsHelperPath ?? resolveDefaultWindowsMusicHelperPath()
  if (!helperPath) return null

  let disposed = false
  let unavailableReported = false
  let child: MusicPresenceWatchProcess

  try {
    child = spawnCommand(helperPath, ['--watch'])
  } catch {
    return null
  }

  const lines = createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  })

  function reportUnavailable() {
    if (disposed || unavailableReported) return
    unavailableReported = true
    onUnavailable?.()
  }

  const readCachedWindowsSpotifyTrackUri =
    createCachedWindowsSpotifyTrackUriReader(readWindowsSpotifyTrackUri, now)

  lines.on('line', (line) => {
    const presence = finalizeDesktopMusicPresence(
      getSettings(),
      normalizeWindowsNowPlayingPayload(parseProbeJson(line), now()),
      {
        platform,
        readWindowsSpotifyTrackUri: readCachedWindowsSpotifyTrackUri,
      },
    )
    onChange(presence)
  })
  child.once('error', reportUnavailable)
  child.once('exit', reportUnavailable)

  return () => {
    disposed = true
    lines.close()
    if (!child.killed) child.kill()
  }
}

export function normalizeWindowsNowPlayingPayload(
  payload: unknown,
  observedAt = Date.now(),
): MusicPresence | null {
  if (!payload || typeof payload !== 'object') return null
  const data = payload as WindowsNowPlayingPayload
  const provider = providerFromWindowsAppId(data.appUserModelId)
  if (!provider) return null
  const sampleObservedAt = finiteNumber(data.observedAt) ?? observedAt

  return normalizeMusicPresence({
    provider,
    source: 'desktop_now_playing',
    title: data.title,
    artists: splitArtistText(data.artist),
    album: data.albumTitle,
    artworkUrl: data.artworkUrl,
    externalUrl: data.externalUrl,
    durationMs: data.durationMs,
    progressMs: data.positionMs,
    isPlaying: String(data.playbackStatus).toLowerCase() === 'playing',
    observedAt: sampleObservedAt,
  })
}

export function normalizeMacNowPlayingPayload(
  payload: unknown,
  observedAt = Date.now(),
): MusicPresence | null {
  if (!payload || typeof payload !== 'object') return null
  const data = payload as MacNowPlayingPayload
  const provider = providerFromMacAppName(data.app)
  if (!provider) return null

  return normalizeMusicPresence({
    provider,
    source: 'desktop_now_playing',
    title: data.title,
    artists: splitArtistText(data.artist),
    album: data.album,
    artworkUrl: data.artworkUrl,
    externalUrl: data.externalUrl,
    durationMs: secondsToMs(data.durationSeconds),
    progressMs: secondsToMs(data.positionSeconds),
    isPlaying: String(data.playerState).toLowerCase() === 'playing',
    observedAt,
  })
}

function hasEnabledDesktopMusicProvider(
  providers: DesktopLocalSettings['music']['providers'],
) {
  return Object.values(providers).some(
    (provider) => provider.enabled && provider.source === 'desktop_now_playing',
  )
}

function providerEnabledForDesktop(
  settings: Pick<DesktopLocalSettings, 'music'>,
  presence: MusicPresence | null,
): presence is MusicPresence {
  if (!presence) return false
  const provider = settings.music.providers[presence.provider]
  return provider.enabled && provider.source === 'desktop_now_playing'
}

function finalizeDesktopMusicPresence(
  settings: Pick<DesktopLocalSettings, 'music'>,
  presence: MusicPresence | null,
  options: {
    platform: NodeJS.Platform
    readWindowsSpotifyTrackUri: WindowsSpotifyTrackUriReader
  },
) {
  if (!settings.music.enabled || !settings.music.showInProfile) return null
  if (!providerEnabledForDesktop(settings, presence)) return null
  if (!presence.isPlaying) return null
  return withResolvedExternalUrl(settings, presence, options)
}

function withResolvedExternalUrl(
  settings: Pick<DesktopLocalSettings, 'music'>,
  presence: MusicPresence,
  {
    platform,
    readWindowsSpotifyTrackUri,
  }: {
    platform: NodeJS.Platform
    readWindowsSpotifyTrackUri: WindowsSpotifyTrackUriReader
  },
) {
  if (presence.externalUrl) return presence

  const provider = settings.music.providers[presence.provider]
  if (!provider.resolveExternalLinks) return presence

  if (platform === 'win32' && presence.provider === 'spotify') {
    const externalUrl = readWindowsSpotifyTrackUri(presence)
    if (externalUrl) return { ...presence, externalUrl }
  }

  return presence
}

function parseProbeJson(output: string) {
  const text = output.trim()
  if (!text || text === 'null') return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function providerFromWindowsAppId(value: unknown): MusicProviderId | undefined {
  if (typeof value !== 'string') return undefined
  const appId = value.toLowerCase()
  if (appId.includes('spotify')) return 'spotify'
  if (appId.includes('apple') && appId.includes('music')) return 'apple_music'
  if (isYandexMusicWindowsAppId(appId)) return 'yandex_music'
  return undefined
}

function isYandexMusicWindowsAppId(appId: string) {
  if (WINDOWS_BROWSER_APP_ID_PARTS.some((part) => appId.includes(part))) {
    return false
  }
  return appId.includes('yandex') && appId.includes('music')
}

function providerFromMacAppName(value: unknown): MusicProviderId | undefined {
  if (typeof value !== 'string') return undefined
  const appName = value.toLowerCase()
  if (appName === 'spotify') return 'spotify'
  if (appName === 'music' || appName === 'itunes') return 'apple_music'
  if (appName.includes('yandex')) return 'yandex_music'
  return undefined
}

function splitArtistText(value: unknown) {
  if (typeof value !== 'string') return []
  return value
    .split(/[,;&]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function secondsToMs(value: unknown) {
  const seconds = finiteNumber(value)
  return seconds === undefined ? undefined : Math.max(0, Math.round(seconds * 1000))
}

function finiteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function resolveDefaultWindowsMusicHelperPath() {
  const mainDir = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.resourcesPath
      ? path.join(process.resourcesPath, 'native', WINDOWS_MUSIC_HELPER_EXE)
      : null,
    path.resolve(mainDir, '../native', WINDOWS_MUSIC_HELPER_EXE),
    path.resolve(mainDir, '../../out/native', WINDOWS_MUSIC_HELPER_EXE),
  ]

  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null
}

export function spotifyTrackUriFromStateText(
  text: string,
  track?: Pick<MusicPresence, 'artists' | 'title'>,
) {
  const matches = Array.from(text.matchAll(SPOTIFY_TRACK_URI_PATTERN))
  if (matches.length === 0) return undefined
  if (!track) return matches.at(-1)?.[0]

  const normalizedText = text.toLowerCase()
  const title = normalizeSpotifyStateNeedle(track.title)
  if (!title) return matches.at(-1)?.[0]

  const titlePositions = findNeedlePositions(normalizedText, title)
  if (titlePositions.length === 0) {
    return hasNonAsciiText(track.title) ? matches.at(-1)?.[0] : undefined
  }

  const artistPositions = track.artists
    .flatMap((artist) =>
      findNeedlePositions(normalizedText, normalizeSpotifyStateNeedle(artist)),
    )
    .filter((position) => position >= 0)

  let bestArtistMatch: { uri: string; distance: number } | null = null
  let bestTitleMatch: { uri: string; distance: number } | null = null
  for (const match of matches) {
    const uri = match[0]
    const uriIndex = match.index ?? 0
    for (const titleIndex of titlePositions) {
      const distance = Math.abs(uriIndex - titleIndex)
      if (distance > SPOTIFY_STATE_MATCH_WINDOW_CHARS) continue

      if (!bestTitleMatch || distance < bestTitleMatch.distance) {
        bestTitleMatch = { uri, distance }
      }

      const hasNearbyArtist =
        artistPositions.length === 0 ||
        artistPositions.some(
          (artistIndex) =>
            Math.abs(artistIndex - titleIndex) <=
              SPOTIFY_STATE_MATCH_WINDOW_CHARS ||
            Math.abs(artistIndex - uriIndex) <= SPOTIFY_STATE_MATCH_WINDOW_CHARS,
        )
      if (hasNearbyArtist && (!bestArtistMatch || distance < bestArtistMatch.distance)) {
        bestArtistMatch = { uri, distance }
      }
    }
  }

  return bestArtistMatch?.uri ?? bestTitleMatch?.uri
}

function createCachedWindowsSpotifyTrackUriReader(
  readTrackUri: WindowsSpotifyTrackUriReader,
  now: () => number,
): WindowsSpotifyTrackUriReader {
  let cache:
    | {
        key: string
        expiresAt: number
        value: string | undefined
      }
    | null = null

  return (presence) => {
    const key = windowsSpotifyTrackUriCacheKey(presence)
    const observedAt = now()
    if (cache && cache.key === key && cache.expiresAt > observedAt) {
      return cache.value
    }

    const value = readTrackUri(presence)
    cache = {
      key,
      expiresAt: observedAt + WINDOWS_SPOTIFY_TRACK_URI_CACHE_TTL_MS,
      value,
    }
    return value
  }
}

function windowsSpotifyTrackUriCacheKey(presence: MusicPresence) {
  return [
    presence.provider,
    presence.source,
    presence.title,
    presence.artists.join('\u0000'),
    presence.album ?? '',
    presence.durationMs ?? '',
  ].join('\u0001')
}

function readDefaultWindowsSpotifyTrackUri(presence: MusicPresence) {
  for (const filePath of resolveWindowsSpotifyStateFiles()) {
    const uri = readSpotifyTrackUriFromStateFile(filePath, presence)
    if (uri) return uri
  }
  return undefined
}

function resolveWindowsSpotifyStateFiles() {
  const userRoots = [
    process.env.LOCALAPPDATA
      ? path.join(
          process.env.LOCALAPPDATA,
          'Packages',
          'SpotifyAB.SpotifyMusic_zpdnekdrzrea0',
          'LocalState',
          'Spotify',
          'Users',
        )
      : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'Spotify', 'Users') : null,
  ].filter(Boolean) as string[]

  const files: Array<{ filePath: string; mtimeMs: number }> = []
  for (const root of userRoots) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.endsWith('-user')) continue
        const filePath = path.join(root, entry.name, SPOTIFY_CONTEXT_STATE_FILE)
        if (!existsSync(filePath)) continue
        files.push({
          filePath,
          mtimeMs: statSync(filePath).mtimeMs,
        })
      }
    } catch {
      // Spotify state is an optional best-effort source.
    }
  }

  return files
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .map((entry) => entry.filePath)
}

function readSpotifyTrackUriFromStateFile(filePath: string, presence: MusicPresence) {
  try {
    const stats = statSync(filePath)
    if (!stats.isFile() || stats.size <= 0 || stats.size > SPOTIFY_STATE_MAX_BYTES) {
      return undefined
    }
    return spotifyTrackUriFromStateText(readFileSync(filePath, 'utf8'), presence)
  } catch {
    return undefined
  }
}

function normalizeSpotifyStateNeedle(value: string) {
  return value.trim().toLowerCase()
}

function hasNonAsciiText(value: string) {
  return /[^\x00-\x7F]/.test(value)
}

function findNeedlePositions(text: string, needle: string) {
  if (!needle) return []

  const positions: number[] = []
  let position = text.indexOf(needle)
  while (position >= 0) {
    positions.push(position)
    position = text.indexOf(needle, position + needle.length)
  }

  return positions
}

function runOsCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: PROBE_MAX_BUFFER_BYTES,
      },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(stdout)
      },
    )
  })
}

function runWatchCommand(command: string, args: string[]) {
  return spawn(command, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
