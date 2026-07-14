import type {
  DesktopOverlayGameTarget,
  DesktopOverlaySettings,
} from '@syrnike13/platform'

import { OVERLAY_EXCLUDED_PROCESS_NAMES } from './overlay-game-exclusions'
import { POPULAR_GAME_PROCESS_NAMES } from './overlay-game-processes'
import { hooksRuntimeController } from './native-runtime/hooks-runtime-controller'

export type OverlayForegroundWindow = {
  pid: number
  processName: string
  processPath: string | null
  title: string
  className: string
  visible: boolean
  fullscreenLike: boolean
  bounds: {
    x: number
    y: number
    width: number
    height: number
  }
}

const GAME_PATH_MARKERS = [
  '/steamapps/common/',
  '/epic games/',
  '/gog games/',
  '/gog galaxy/games/',
  '/xboxgames/',
  '/riot games/',
  '/battle.net/',
  '/ubisoft game launcher/games/',
  '/ea games/',
  '/origin games/',
]

const PROTECTED_GAME_SIGNATURES = [
  {
    className: 'riotwindowclass',
  },
]

const DETECTED_GAME_LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1_000

let targetListener: ((target: DesktopOverlayGameTarget | null) => void) | null = null

function handleForegroundWindow(window: OverlayForegroundWindow | null) {
  targetListener?.(buildOverlayGameTarget(window, process.pid))
}

export function startOverlayGameDetector(
  onTargetChanged: (target: DesktopOverlayGameTarget | null) => void,
) {
  if (process.platform !== 'win32') {
    onTargetChanged(null)
    return
  }

  if (!hooksRuntimeController.isAvailable('overlay')) {
    onTargetChanged(null)
    return
  }

  if (targetListener) {
    targetListener = onTargetChanged
    return
  }
  targetListener = onTargetChanged
  void hooksRuntimeController.startOverlay(handleForegroundWindow).catch((error) => {
    console.warn(
      '[overlay-detector] native runtime failed to start',
      error instanceof Error ? error.message : 'unknown error',
    )
    onTargetChanged(null)
  })
}

export function disposeOverlayGameDetector() {
  targetListener = null
  void hooksRuntimeController.stopOverlay(handleForegroundWindow)
}

export function buildOverlayGameTarget(
  window: OverlayForegroundWindow | null,
  ownPid: number,
): DesktopOverlayGameTarget | null {
  if (!window || !window.visible) return null
  if (window.pid === ownPid) return null

  const processName = window.processName.trim()
  if (!processName) return null
  if (OVERLAY_EXCLUDED_PROCESS_NAMES.has(processName.toLowerCase())) return null
  if (window.bounds.width <= 0 || window.bounds.height <= 0) return null

  const processPath = window.processPath?.trim() || null
  if (!hasGameIdentitySignal(window, processPath)) return null
  return {
    gameId: overlayGameId(processPath, processName),
    processName,
    processPath,
    title: window.title.trim() || processName,
    bounds: window.bounds,
  }
}

function hasGameIdentitySignal(
  window: OverlayForegroundWindow,
  processPath: string | null,
) {
  if (matchesProtectedGameSignature(window)) return true
  if (isLikelyGameWindowClass(window.className)) return true
  if (POPULAR_GAME_PROCESS_NAMES.has(window.processName.trim().toLowerCase())) {
    return true
  }

  return window.fullscreenLike && isKnownGamePath(processPath)
}

function matchesProtectedGameSignature(window: OverlayForegroundWindow) {
  const className = window.className.toLowerCase()
  return PROTECTED_GAME_SIGNATURES.some(
    (signature) =>
      className === signature.className &&
      window.fullscreenLike,
  )
}

function isLikelyGameWindowClass(className: string) {
  const normalized = className.toLowerCase()
  return (
    normalized.includes('unreal') ||
    normalized.includes('unity') ||
    normalized.includes('godot') ||
    normalized.includes('sdl') ||
    normalized.includes('glfw') ||
    normalized.includes('cryengine')
  )
}

function isKnownGamePath(processPath: string | null) {
  if (!processPath) return false
  const normalizedPath = processPath.replaceAll('\\', '/').toLowerCase()
  return GAME_PATH_MARKERS.some((marker) => normalizedPath.includes(marker))
}

export function rememberDetectedOverlayGame(
  settings: DesktopOverlaySettings,
  target: DesktopOverlayGameTarget,
  lastSeenAt: number,
): DesktopOverlaySettings {
  const existing = settings.games.find((game) => game.id === target.gameId)
  if (
    existing &&
    existing.processName === target.processName &&
    existing.processPath === target.processPath &&
    existing.title === target.title &&
    lastSeenAt - existing.lastSeenAt < DETECTED_GAME_LAST_SEEN_WRITE_INTERVAL_MS
  ) {
    return settings
  }
  const nextGame = {
    id: target.gameId,
    processName: target.processName,
    processPath: target.processPath,
    title: target.title,
    enabled: existing?.enabled ?? true,
    lastSeenAt,
  }

  return {
    ...settings,
    games: existing
      ? settings.games.map((game) =>
          game.id === target.gameId ? nextGame : game,
        )
      : [...settings.games, nextGame],
  }
}

function overlayGameId(processPath: string | null, processName: string) {
  return (processPath || processName).replaceAll('\\', '/').toLowerCase()
}
