import { spawn, type ChildProcessByStdio } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import type { Readable } from 'node:stream'

import { app } from 'electron'
import type {
  DesktopOverlayGameTarget,
  DesktopOverlaySettings,
} from '@syrnike13/platform'

import { OVERLAY_EXCLUDED_PROCESS_NAMES } from './overlay-game-exclusions'

export type OverlayForegroundWindow = {
  pid: number
  processName: string
  processPath: string | null
  title: string
  className: string
  visible: boolean
  fullscreenLike: boolean
  graphicsModules: string[]
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

const GRAPHICS_RUNTIME_MODULES = new Set([
  'd3d9.dll',
  'd3d10.dll',
  'd3d10core.dll',
  'd3d11.dll',
  'd3d12.dll',
  'dxgi.dll',
  'opengl32.dll',
  'vulkan-1.dll',
])

const GAME_RUNTIME_MODULES = new Set([
  'gameassembly.dll',
  'godot.windows.opt.tools.64.exe',
  'godot.windows.template_release.x86_64.exe',
  'unityplayer.dll',
])

const PROTECTED_GAME_SIGNATURES = [
  {
    className: 'riotwindowclass',
  },
]

let helper: ChildProcessByStdio<null, Readable, Readable> | null = null

export function startOverlayGameDetector(
  onTargetChanged: (target: DesktopOverlayGameTarget | null) => void,
) {
  if (process.platform !== 'win32') {
    onTargetChanged(null)
    return
  }

  const helperPath = resolveOverlayDetectorPath()
  if (!helperPath) {
    onTargetChanged(null)
    return
  }

  helper?.kill()
  const nextHelper = spawn(helperPath, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  helper = nextHelper

  const lines = readline.createInterface({ input: nextHelper.stdout })
  lines.on('line', (line) => {
    onTargetChanged(
      buildOverlayGameTarget(parseOverlayForegroundWindow(line), process.pid),
    )
  })

  nextHelper.stderr.resume()
  nextHelper.on('exit', () => {
    if (helper === nextHelper) helper = null
    onTargetChanged(null)
  })
}

export function disposeOverlayGameDetector() {
  helper?.kill()
  helper = null
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
  if (!hasGameRuntimeSignal(window, processPath)) return null
  return {
    gameId: overlayGameId(processPath, processName),
    processName,
    processPath,
    title: window.title.trim() || processName,
    bounds: window.bounds,
  }
}

function hasGameRuntimeSignal(
  window: OverlayForegroundWindow,
  processPath: string | null,
) {
  if (matchesProtectedGameSignature(window)) return true

  const modules = new Set(
    window.graphicsModules.map((moduleName) => moduleName.toLowerCase()),
  )
  const hasGameRuntimeModule = [...modules].some((moduleName) =>
    GAME_RUNTIME_MODULES.has(moduleName),
  )
  if (hasGameRuntimeModule) return true

  const hasGraphicsRuntimeModule = [...modules].some((moduleName) =>
    GRAPHICS_RUNTIME_MODULES.has(moduleName),
  )
  if (!hasGraphicsRuntimeModule) return false

  return (
    window.fullscreenLike ||
    isKnownGamePath(processPath) ||
    isLikelyGameWindowClass(window.className)
  )
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

function parseOverlayForegroundWindow(line: string) {
  try {
    const parsed = JSON.parse(line) as Partial<OverlayForegroundWindow>
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.processName !== 'string' ||
      typeof parsed.title !== 'string' ||
      typeof parsed.className !== 'string' ||
      typeof parsed.visible !== 'boolean' ||
      typeof parsed.fullscreenLike !== 'boolean' ||
      !parsed.bounds ||
      typeof parsed.bounds !== 'object'
    ) {
      return null
    }

    const bounds = parsed.bounds as Partial<OverlayForegroundWindow['bounds']>
    if (
      typeof bounds.x !== 'number' ||
      typeof bounds.y !== 'number' ||
      typeof bounds.width !== 'number' ||
      typeof bounds.height !== 'number'
    ) {
      return null
    }

    return {
      pid: parsed.pid,
      processName: parsed.processName,
      processPath:
        typeof parsed.processPath === 'string' && parsed.processPath.length > 0
          ? parsed.processPath
          : null,
      title: parsed.title,
      className: parsed.className,
      visible: parsed.visible,
      fullscreenLike: parsed.fullscreenLike,
      graphicsModules: Array.isArray(parsed.graphicsModules)
        ? parsed.graphicsModules.filter(
            (moduleName): moduleName is string =>
              typeof moduleName === 'string' && moduleName.length > 0,
          )
        : [],
      bounds: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      },
    }
  } catch {
    return null
  }
}

function resolveOverlayDetectorPath() {
  const helperName = 'syrnike-overlay-detector-win.exe'
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'native', helperName)]
    : [
        path.resolve(app.getAppPath(), 'out/native', helperName),
        path.resolve(
          app.getAppPath(),
          'native/overlay-detector-win/build/Release',
          helperName,
        ),
        path.resolve(
          app.getAppPath(),
          'native/overlay-detector-win/build/Debug',
          helperName,
        ),
      ]

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
}
