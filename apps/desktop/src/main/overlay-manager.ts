import { BrowserWindow, screen, type WebContents } from 'electron'
import {
  DEFAULT_DESKTOP_OVERLAY_SETTINGS,
  EMPTY_DESKTOP_OVERLAY_SNAPSHOT,
  IPC,
  desktopOverlaySnapshotsEqual,
  normalizeDesktopOverlaySnapshot,
  type DesktopOverlayGameTarget,
  type DesktopOverlaySettings,
  type DesktopOverlaySnapshot,
  type DesktopOverlayState,
} from '@syrnike13/platform'

import { resolvePreloadScript } from './paths'
import {
  disposeOverlayGameDetector,
  rememberDetectedOverlayGame,
  startOverlayGameDetector,
} from './overlay-game-detector'

export const DESKTOP_OVERLAY_PANEL_WIDTH = 296
export const DESKTOP_OVERLAY_WINDOW_PADDING = 20
export const DESKTOP_OVERLAY_TARGET_INSET = 16
export const DESKTOP_OVERLAY_PARTICIPANT_HEIGHT = 40
export const DESKTOP_OVERLAY_PARTICIPANT_GAP = 4
export const DESKTOP_OVERLAY_WINDOW_WIDTH =
  DESKTOP_OVERLAY_PANEL_WIDTH + DESKTOP_OVERLAY_WINDOW_PADDING * 2
export const DESKTOP_OVERLAY_RECOVERY_LIMIT = 3
export const DESKTOP_OVERLAY_RECOVERY_WINDOW_MS = 30_000
const DESKTOP_OVERLAY_RECOVERY_DELAY_MS = 250

type OverlayPoint = { x: number; y: number }
type OverlayCoordinateSpace = {
  toDipPoint: (point: OverlayPoint) => OverlayPoint
  getScaleFactor: (dipPoint: OverlayPoint) => number
}

const IDENTITY_OVERLAY_COORDINATE_SPACE: OverlayCoordinateSpace = {
  toDipPoint: (point) => point,
  getScaleFactor: () => 1,
}

let overlayWindow: BrowserWindow | null = null
let overlayLoadUrl: string | null = null
let getMainWindowRef: (() => BrowserWindow | null) | null = null
let persistOverlaySettings:
  | ((settings: DesktopOverlaySettings) => Promise<void>)
  | null = null
let detectorRunning = false
let overlayRecoveryTimer: ReturnType<typeof setTimeout> | null = null
let overlayRecoveryFailures: number[] = []
let overlayState = createDesktopOverlayState(process.platform)
let overlaySettings: DesktopOverlaySettings = {
  ...DEFAULT_DESKTOP_OVERLAY_SETTINGS,
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
  settings: DesktopOverlaySettings,
): DesktopOverlayState {
  const normalized = normalizeDesktopOverlaySnapshot(snapshot)
  return {
    ...state,
    snapshot: normalized,
    visible:
      canShowDesktopOverlay(state, normalized, state.target) &&
      Boolean(
        state.target &&
          isOverlayGameEnabled(state.target.gameId, settings),
      ),
  }
}

export function shouldRunDesktopOverlayDetector(
  state: DesktopOverlayState,
  settings: DesktopOverlaySettings,
) {
  return (
    state.available && state.enabled && settings.enabled && state.snapshot.active
  )
}

export function calculateDesktopOverlayWindowBounds(
  targetBounds: DesktopOverlayGameTarget['bounds'],
  participantCount: number,
  coordinateSpace: OverlayCoordinateSpace = IDENTITY_OVERLAY_COORDINATE_SPACE,
) {
  // Use one point strictly inside the target to select a single display and
  // scale. An exclusive bottom-right point can belong to the adjacent display
  // for fullscreen windows, which would mix two DPI coordinate spaces.
  const anchorOffset = {
    x: Math.min(
      DESKTOP_OVERLAY_TARGET_INSET,
      Math.max(0, targetBounds.width - 1),
    ),
    y: Math.min(
      DESKTOP_OVERLAY_TARGET_INSET,
      Math.max(0, targetBounds.height - 1),
    ),
  }
  const convertedAnchor = coordinateSpace.toDipPoint({
    x: targetBounds.x + anchorOffset.x,
    y: targetBounds.y + anchorOffset.y,
  })
  const scaleFactor = Math.max(
    0.01,
    coordinateSpace.getScaleFactor(convertedAnchor),
  )
  const topLeft = {
    x: Math.round(convertedAnchor.x - anchorOffset.x / scaleFactor),
    y: Math.round(convertedAnchor.y - anchorOffset.y / scaleFactor),
  }
  const targetWidth = Math.max(1, Math.round(targetBounds.width / scaleFactor))
  const targetHeight = Math.max(
    1,
    Math.round(targetBounds.height / scaleFactor),
  )
  const width = Math.min(
    DESKTOP_OVERLAY_WINDOW_WIDTH,
    Math.max(1, targetWidth - DESKTOP_OVERLAY_TARGET_INSET),
  )
  const rows = Math.max(1, participantCount)
  const contentHeight =
    rows * DESKTOP_OVERLAY_PARTICIPANT_HEIGHT +
    Math.max(0, rows - 1) * DESKTOP_OVERLAY_PARTICIPANT_GAP
  const desiredHeight = contentHeight + DESKTOP_OVERLAY_WINDOW_PADDING * 2
  const height = Math.min(
    desiredHeight,
    Math.max(1, targetHeight - DESKTOP_OVERLAY_TARGET_INSET),
  )

  return {
    x: Math.min(
      topLeft.x + DESKTOP_OVERLAY_TARGET_INSET,
      topLeft.x + targetWidth - width,
    ),
    y: Math.min(
      topLeft.y + DESKTOP_OVERLAY_TARGET_INSET,
      topLeft.y + targetHeight - height,
    ),
    width,
    height,
  }
}

export function nextDesktopOverlayRecoveryFailures(
  failures: readonly number[],
  now: number,
): number[] | null {
  const recent = failures.filter(
    (failureAt) => now - failureAt < DESKTOP_OVERLAY_RECOVERY_WINDOW_MS,
  )
  if (recent.length >= DESKTOP_OVERLAY_RECOVERY_LIMIT) return null
  return [...recent, now]
}

export function updateDesktopOverlayEnabled(
  state: DesktopOverlayState,
  enabled: boolean,
  settings: DesktopOverlaySettings,
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
          isOverlayGameEnabled(state.target.gameId, settings),
      ),
  }
}

export function updateDesktopOverlayGameTarget(
  state: DesktopOverlayState,
  target: DesktopOverlayGameTarget | null,
  settings: DesktopOverlaySettings,
): DesktopOverlayState {
  return {
    ...state,
    target,
    visible:
      state.available &&
      state.enabled &&
      settings.enabled &&
      state.snapshot.active &&
      Boolean(target && isOverlayGameEnabled(target.gameId, settings)),
  }
}

export function configureDesktopOverlay(
  loadUrl: string,
  getMainWindow: () => BrowserWindow | null,
  options?: {
    settings?: DesktopOverlaySettings
    persistSettings?: (settings: DesktopOverlaySettings) => Promise<void>
  },
) {
  overlayLoadUrl = loadUrl
  getMainWindowRef = getMainWindow
  persistOverlaySettings = options?.persistSettings ?? null
  if (options?.settings) {
    setDesktopOverlaySettings(options.settings)
  }
  syncOverlayGameDetectorDemand()
}

export function getDesktopOverlayState() {
  return overlayState
}

export function setDesktopOverlayEnabled(enabled: boolean) {
  overlayState = updateDesktopOverlayEnabled(
    overlayState,
    enabled,
    overlaySettings,
  )
  syncOverlayGameDetectorDemand()
  applyDesktopOverlayVisibility()
  emitDesktopOverlayState()
  return overlayState
}

export function getDesktopOverlaySettings() {
  return overlaySettings
}

export function setDesktopOverlaySettings(settings: DesktopOverlaySettings) {
  overlaySettings = settings
  overlayState = updateDesktopOverlayGameTarget(
    {
      ...overlayState,
      enabled: overlayState.available && settings.enabled,
    },
    overlayState.target,
    overlaySettings,
  )
  syncOverlayGameDetectorDemand()
  applyDesktopOverlayVisibility()
  emitDesktopOverlayState()
  return overlaySettings
}

export function setDesktopOverlayGameTarget(
  target: DesktopOverlayGameTarget | null,
) {
  overlayState = updateDesktopOverlayGameTarget(
    overlayState,
    target,
    overlaySettings,
  )
  applyDesktopOverlayVisibility()
  emitDesktopOverlayState()
  return overlayState
}

export function setDesktopOverlaySnapshot(snapshot: DesktopOverlaySnapshot) {
  const normalized = normalizeDesktopOverlaySnapshot(snapshot)
  if (desktopOverlaySnapshotsEqual(overlayState.snapshot, normalized)) {
    return overlayState
  }
  overlayState = updateDesktopOverlaySnapshot(
    overlayState,
    normalized,
    overlaySettings,
  )
  syncOverlayGameDetectorDemand()
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
  destroyOverlayWindow()
  disposeOverlayGameDetector()
  detectorRunning = false
  overlayLoadUrl = null
  getMainWindowRef = null
  persistOverlaySettings = null
  overlaySettings = { ...DEFAULT_DESKTOP_OVERLAY_SETTINGS }
  overlayState = createDesktopOverlayState(process.platform)
}

function handleOverlayGameTarget(target: DesktopOverlayGameTarget | null) {
  if (target) {
    const nextSettings = rememberDetectedOverlayGame(
      overlaySettings,
      target,
      Date.now(),
    )
    if (nextSettings !== overlaySettings) {
      overlaySettings = nextSettings
      void persistOverlaySettings?.(nextSettings).catch((error) => {
        console.error('[desktop-overlay] failed to save detected game', error)
      })
    }
  }

  setDesktopOverlayGameTarget(target)
}

function syncOverlayGameDetectorDemand() {
  const shouldRun = shouldRunDesktopOverlayDetector(
    overlayState,
    overlaySettings,
  )
  if (shouldRun === detectorRunning) return

  detectorRunning = shouldRun
  if (shouldRun) {
    startOverlayGameDetector(handleOverlayGameTarget)
    return
  }

  disposeOverlayGameDetector()
  overlayState = {
    ...overlayState,
    target: null,
    visible: false,
  }
  destroyOverlayWindow()
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
  settings: DesktopOverlaySettings,
) {
  if (!settings.enabled) return false
  const game = settings.games.find((item) => item.id === gameId)
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
  if (overlayRecoveryTimer) return null
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow

  const win = new BrowserWindow({
    width: DESKTOP_OVERLAY_WINDOW_WIDTH,
    height:
      DESKTOP_OVERLAY_WINDOW_PADDING * 2 +
      DESKTOP_OVERLAY_PARTICIPANT_HEIGHT,
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

  overlayWindow = win
  win.setIgnoreMouseEvents(true)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.on('closed', () => {
    if (overlayWindow === win) overlayWindow = null
  })
  win.webContents.on('did-fail-load', (_event, _code, description, _url, isMainFrame) => {
    if (!isMainFrame) return
    console.warn('[desktop-overlay] renderer failed to load', description)
    scheduleOverlayWindowRecovery(win)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    console.warn('[desktop-overlay] renderer process gone', details.reason)
    scheduleOverlayWindowRecovery(win)
  })
  win.on('unresponsive', () => {
    console.warn('[desktop-overlay] renderer became unresponsive')
    scheduleOverlayWindowRecovery(win)
  })
  win.webContents.on('did-finish-load', () => emitDesktopOverlayState())
  void win
    .loadURL(new URL('/desktop/overlay', overlayLoadUrl).toString())
    .catch((error) => {
      console.warn('[desktop-overlay] renderer load rejected', error)
      scheduleOverlayWindowRecovery(win)
    })

  return win
}

function scheduleOverlayWindowRecovery(win: BrowserWindow) {
  if (overlayWindow !== win || win.isDestroyed()) return
  const nextFailures = nextDesktopOverlayRecoveryFailures(
    overlayRecoveryFailures,
    Date.now(),
  )
  overlayWindow = null
  win.destroy()
  if (!nextFailures) {
    console.error('[desktop-overlay] renderer recovery limit reached')
    const retryAt =
      (overlayRecoveryFailures[0] ?? Date.now()) +
      DESKTOP_OVERLAY_RECOVERY_WINDOW_MS
    scheduleOverlayWindowRecoveryAttempt(Math.max(1, retryAt - Date.now()))
    return
  }

  overlayRecoveryFailures = nextFailures
  scheduleOverlayWindowRecoveryAttempt(DESKTOP_OVERLAY_RECOVERY_DELAY_MS)
}

function scheduleOverlayWindowRecoveryAttempt(delayMs: number) {
  overlayRecoveryTimer = setTimeout(() => {
    overlayRecoveryTimer = null
    if (overlayState.visible) applyDesktopOverlayVisibility()
  }, delayMs)
}

function destroyOverlayWindow() {
  if (overlayRecoveryTimer) clearTimeout(overlayRecoveryTimer)
  overlayRecoveryTimer = null
  overlayRecoveryFailures = []
  const win = overlayWindow
  overlayWindow = null
  if (win && !win.isDestroyed()) win.destroy()
}

function positionOverlayWindow(win: BrowserWindow) {
  const target = overlayState.target
  if (target) {
    win.setBounds(
      calculateDesktopOverlayWindowBounds(
        target.bounds,
        overlayState.snapshot.participants.length,
        {
          toDipPoint: (point) => screen.screenToDipPoint(point),
          getScaleFactor: (dipPoint) =>
            screen.getDisplayNearestPoint(dipPoint).scaleFactor,
        },
      ),
    )
    return
  }

  const display = screen.getPrimaryDisplay()
  win.setBounds({
    x: display.workArea.x,
    y: display.workArea.y,
    width: DESKTOP_OVERLAY_WINDOW_WIDTH,
    height:
      DESKTOP_OVERLAY_WINDOW_PADDING * 2 +
      DESKTOP_OVERLAY_PARTICIPANT_HEIGHT,
  })
}

function emitDesktopOverlayState() {
  const targets = [getMainWindowRef?.(), overlayWindow]
  for (const win of targets) {
    if (!win || win.isDestroyed()) continue
    win.webContents.send(IPC.overlayStateChanged, overlayState)
  }
}
