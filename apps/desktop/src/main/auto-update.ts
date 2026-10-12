import { app, type BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import { Effect, Fiber, Schedule } from 'effect'

const { autoUpdater } = electronUpdater

import { IPC, type DesktopUpdateState } from '@syrnike13/platform'
import { DESKTOP_RELEASE_METADATA } from './desktop-app-identity'

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

let currentState: DesktopUpdateState = { status: 'idle' }
let getWindowRef: (() => BrowserWindow | null) | null = null
let prepareToQuitRef: (() => void) | null = null
let checkTimer: Fiber.Fiber<void, never> | null = null
let started = false
let startupCheckActive = false
let inFlightUpdateCheck: Fiber.Fiber<DesktopUpdateState, never> | null = null

function broadcastState() {
  const win = getWindowRef?.()
  if (!win || win.isDestroyed()) return
  win.webContents.send(IPC.updatesStateChanged, currentState)
}

function setState(state: DesktopUpdateState) {
  currentState = state
  broadcastState()
}

export function getDesktopUpdateState() {
  return currentState
}

export const checkForDesktopUpdatesEffect = Effect.fn(
  'desktop.checkForUpdates',
)(function*() {
  if (!DESKTOP_RELEASE_METADATA.autoUpdateEnabled) {
    return currentState
  }
  if (!app.isPackaged) return currentState
  return yield* Fiber.join(startUpdateCheck())
})

export function checkForDesktopUpdates() {
  return Effect.runPromise(checkForDesktopUpdatesEffect())
}

function startUpdateCheck() {
  if (inFlightUpdateCheck) return inFlightUpdateCheck

  let fiber: Fiber.Fiber<DesktopUpdateState, never>
  const operation = Effect.sync(() => {
    setState({ status: 'checking' })
  }).pipe(
    Effect.andThen(
      Effect.tryPromise({
        try: () => autoUpdater.checkForUpdates(),
        catch: (cause) => cause,
      }),
    ),
    Effect.catch((error) =>
      Effect.sync(() => {
        startupCheckActive = false
        setState({
          status: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Не удалось проверить обновления',
        })
      }),
    ),
    Effect.map(() => currentState),
    Effect.ensuring(
      Effect.sync(() => {
        if (inFlightUpdateCheck === fiber) inFlightUpdateCheck = null
      }),
    ),
  )
  fiber = Effect.runFork(operation)
  inFlightUpdateCheck = fiber
  return fiber
}

export function quitAndInstallDesktopUpdate() {
  if (!DESKTOP_RELEASE_METADATA.autoUpdateEnabled) return
  if (!app.isPackaged) return
  prepareToQuitRef?.()
  autoUpdater.quitAndInstall(true, true)
}

export function initializeDesktopAutoUpdate(
  getWindow: () => BrowserWindow | null,
  prepareToQuit: () => void,
) {
  if (!DESKTOP_RELEASE_METADATA.autoUpdateEnabled) return
  if (!app.isPackaged || started) return
  started = true
  startupCheckActive = true
  getWindowRef = getWindow
  prepareToQuitRef = prepareToQuit

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowDowngrade = false

  autoUpdater.on('checking-for-update', () => {
    setState({ status: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    setState({ status: 'available', version: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    startupCheckActive = false
    setState({ status: 'idle' })
  })

  autoUpdater.on('download-progress', (progress) => {
    setState({
      status: 'downloading',
      percent: progress.percent,
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    if (startupCheckActive) {
      startupCheckActive = false
      setState({ status: 'installing', version: info.version })
      quitAndInstallDesktopUpdate()
      return
    }
    setState({ status: 'ready', version: info.version })
  })

  autoUpdater.on('error', (error) => {
    startupCheckActive = false
    console.error('[desktop] auto-update error', error)
    setState({
      status: 'error',
      message: error.message,
    })
  })

  void checkForDesktopUpdates()

  checkTimer = Effect.runFork(
    checkForDesktopUpdatesEffect().pipe(
      Effect.ignore,
      Effect.schedule(Schedule.spaced(CHECK_INTERVAL_MS)),
      Effect.delay(CHECK_INTERVAL_MS),
      Effect.asVoid,
    ),
  )
}

export function disposeDesktopAutoUpdate() {
  if (checkTimer) {
    Effect.runFork(Fiber.interrupt(checkTimer))
    checkTimer = null
  }
}
