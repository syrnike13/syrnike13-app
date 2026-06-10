import { BrowserWindow, screen, type WebContents } from 'electron'
import {
  DEFAULT_DESKTOP_OVERLAY_PREFERENCES,
  EMPTY_DESKTOP_OVERLAY_SNAPSHOT,
  IPC,
  normalizeDesktopOverlaySnapshot,
  type DesktopOverlayGameTarget,
  type DesktopOverlayPreferences,
  type DesktopOverlaySnapshot,
  type DesktopOverlayState,
} from '@syrnike13/platform'

import { resolvePreloadScript } from './paths'
import {
  disposeOverlayGameDetector,
  rememberDetectedOverlayGame,
  startOverlayGameDetector,
} from './overlay-game-detector'

const OVERLAY_WIDTH = 320
const OVERLAY_HEIGHT = 420

let overlayWindow: BrowserWindow | null = null
let overlayLoadUrl: string | null = null
let getMainWindowRef: (() => BrowserWindow | null) | null = null
let persistOverlayPreferences:
  | ((preferences: DesktopOverlayPreferences) => Promise<void>)
  | null = null
let overlayState = createDesktopOverlayState(process.platform)
let overlayPreferences: DesktopOverlayPreferences = {
  ...DEFAULT_DESKTOP_OVERLAY_PREFERENCES,
}

export function createDesktopOverlayState(
  platform: NodeJS.Platform,
): DesktopOverlayState {
  const available = platform === 'win32'
  return {
    available,
    enabled: available,
    visible: false,
    target: null,
    snapshot: EMPTY_DESKTOP_OVERLAY_SNAPSHOT,
  }
}

export function updateDesktopOverlaySnapshot(
  state: DesktopOverlayState,
  snapshot: unknown,
): DesktopOverlayState {
  const normalized = normalizeDesktopOverlaySnapshot(snapshot)
  return {
    ...state,
    snapshot: normalized,
    visible:
      canShowDesktopOverlay(state, normalized, state.target) &&
      Boolean(
        state.target &&
          isOverlayGameEnabled(state.target.gameId, overlayPreferences),
      ),
  }
}

export function updateDesktopOverlayEnabled(
  state: DesktopOverlayState,
  enabled: boolean,
): DesktopOverlayState {
  return {
    ...state,
    enabled: state.available && enabled,
    visible:
      state.available &&
      enabled &&
      state.snapshot.active &&
      Boolean(
        state.target &&
          isOverlayGameEnabled(state.target.gameId, overlayPreferences),
      ),
  }
}

export function updateDesktopOverlayGameTarget(
  state: DesktopOverlayState,
  target: DesktopOverlayGameTarget | null,
  preferences: DesktopOverlayPreferences,
): DesktopOverlayState {
  return {
    ...state,
    target,
    visible:
      state.available &&
      state.enabled &&
      preferences.enabled &&
      state.snapshot.active &&
      Boolean(target && isOverlayGameEnabled(target.gameId, preferences)),
  }
}

export function configureDesktopOverlay(
  loadUrl: string,
  getMainWindow: () => BrowserWindow | null,
  options?: {
    preferences?: DesktopOverlayPreferences
    persistPreferences?: (preferences: DesktopOverlayPreferences) => Promise<void>
  },
) {
  overlayLoadUrl = loadUrl
  getMainWindowRef = getMainWindow
  persistOverlayPreferences = options?.persistPreferences ?? null
  if (options?.preferences) {
    setDesktopOverlayPreferences(options.preferences)
  }
  startOverlayGameDetector(handleOverlayGameTarget)
}

export function getDesktopOverlayState() {
  return overlayState
}

export function setDesktopOverlayEnabled(enabled: boolean) {
  overlayState = updateDesktopOverlayEnabled(overlayState, enabled)
  applyDesktopOverlayVisibility()
  emitDesktopOverlayState()
  return overlayState
}

export function getDesktopOverlayPreferences() {
  return overlayPreferences
}

export function setDesktopOverlayPreferences(
  preferences: DesktopOverlayPreferences,
) {
  overlayPreferences = preferences
  overlayState = updateDesktopOverlayGameTarget(
    {
      ...overlayState,
      enabled: overlayState.available && preferences.enabled,
    },
    overlayState.target,
    overlayPreferences,
  )
  applyDesktopOverlayVisibility()
  emitDesktopOverlayState()
  return overlayPreferences
}

export function setDesktopOverlayGameTarget(
  target: DesktopOverlayGameTarget | null,
) {
  overlayState = updateDesktopOverlayGameTarget(
    overlayState,
    target,
    overlayPreferences,
  )
  applyDesktopOverlayVisibility()
  emitDesktopOverlayState()
  return overlayState
}

export function setDesktopOverlaySnapshot(snapshot: DesktopOverlaySnapshot) {
  overlayState = updateDesktopOverlaySnapshot(overlayState, snapshot)
  applyDesktopOverlayVisibility()
  emitDesktopOverlayState()
  return overlayState
}

export function canUseDesktopOverlaySender(webContents: WebContents) {
  const mainWindow = getMainWindowRef?.()
  return (
    Boolean(mainWindow && !mainWindow.isDestroyed() && webContents === mainWindow.webContents) ||
    Boolean(overlayWindow && !overlayWindow.isDestroyed() && webContents === overlayWindow.webContents)
  )
}

export function canSetDesktopOverlaySnapshot(webContents: WebContents) {
  const mainWindow = getMainWindowRef?.()
  return Boolean(
    mainWindow && !mainWindow.isDestroyed() && webContents === mainWindow.webContents,
  )
}

export function disposeDesktopOverlay() {
  overlayWindow?.destroy()
  disposeOverlayGameDetector()
  overlayWindow = null
  overlayLoadUrl = null
  getMainWindowRef = null
  persistOverlayPreferences = null
  overlayPreferences = { ...DEFAULT_DESKTOP_OVERLAY_PREFERENCES }
  overlayState = createDesktopOverlayState(process.platform)
}

function handleOverlayGameTarget(target: DesktopOverlayGameTarget | null) {
  if (target) {
    const nextPreferences = rememberDetectedOverlayGame(
      overlayPreferences,
      target,
      Date.now(),
    )
    if (nextPreferences !== overlayPreferences) {
      overlayPreferences = nextPreferences
      void persistOverlayPreferences?.(nextPreferences).catch((error) => {
        console.error('[desktop-overlay] failed to save detected game', error)
      })
    }
  }

  setDesktopOverlayGameTarget(target)
}

function canShowDesktopOverlay(
  state: DesktopOverlayState,
  snapshot: DesktopOverlaySnapshot,
  target: DesktopOverlayGameTarget | null,
) {
  return state.available && state.enabled && snapshot.active && Boolean(target)
}

function isOverlayGameEnabled(
  gameId: string,
  preferences: DesktopOverlayPreferences,
) {
  if (!preferences.enabled) return false
  const game = preferences.games.find((item) => item.id === gameId)
  return game?.enabled ?? true
}

function applyDesktopOverlayVisibility() {
  if (!overlayState.visible) {
    overlayWindow?.hide()
    return
  }

  const win = ensureOverlayWindow()
  if (!win) return
  positionOverlayWindow(win)
  if (!win.isVisible()) win.showInactive()
}

function ensureOverlayWindow() {
  if (!overlayState.available || !overlayLoadUrl) return null
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow

  overlayWindow = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    webPreferences: {
      preload: resolvePreloadScript(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  overlayWindow.setIgnoreMouseEvents(true)
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.on('closed', () => {
    overlayWindow = null
  })
  void overlayWindow.loadURL(new URL('/desktop/overlay', overlayLoadUrl).toString())

  return overlayWindow
}

function positionOverlayWindow(win: BrowserWindow) {
  const target = overlayState.target
  if (target) {
    win.setBounds(target.bounds)
    return
  }

  const display = screen.getPrimaryDisplay()
  win.setBounds({
    x: display.workArea.x,
    y: display.workArea.y,
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
  })
}

function emitDesktopOverlayState() {
  const targets = [getMainWindowRef?.(), overlayWindow]
  for (const win of targets) {
    if (!win || win.isDestroyed()) continue
    win.webContents.send(IPC.overlayStateChanged, overlayState)
  }
}
