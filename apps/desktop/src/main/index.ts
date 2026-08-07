import path from 'node:path'

import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  Tray,
  type MenuItemConstructorOptions,
} from 'electron'
import type {
  DesktopLocalSettings,
  DesktopLocalSettingsPatch,
  DesktopOverlaySettings,
} from '@syrnike13/platform'
import type { DesktopTrayVoiceState } from '@syrnike13/platform'
import { Effect, Semaphore } from 'effect'

import { installStdioPipeErrorHandlers } from './stdio-pipe-errors'
import {
  disposeDesktopAutoUpdate,
  initializeDesktopAutoUpdate,
} from './auto-update'
import { registerDesktopIpc } from './ipc'
import { disposeHotkeys } from './hotkeys'
import { hooksRuntimeController } from './native-runtime/hooks-runtime-controller'
import {
  configureDesktopOverlay,
  disposeDesktopOverlay,
} from './overlay-manager'
import {
  disposeNativeMediaRuntimeEffect,
  logNativeVoiceDiagnostic,
  startNativeMediaRuntime,
} from './native-media-engine'
import { resolveWebDistRoot } from './paths'
import { createMainWindow } from './window'
import {
  startEmbeddedWebServerEffect,
  type EmbeddedWebServer,
} from './web-server'
import { resolveDesktopAsset } from './paths'
import {
  DEFAULT_DESKTOP_PREFERENCES,
  loadDesktopPreferencesEffect,
  saveDesktopPreferencesEffect,
  type DesktopPreferences,
} from './desktop-preferences'
import {
  desktopLocalSettingsDefaults,
  loadDesktopLocalSettingsEffect,
  updateDesktopLocalSettingsEffect,
} from './desktop-local-settings'
import { desktopSessionPath } from './desktop-session'
import { routeFromDeepLink } from './deep-links'
import { applyLoginItemSettings } from './login-item'
import {
  normalizeDesktopTrayVoiceState,
  TRAY_ICON_ASSET_BY_STATE,
} from './tray-icon'
import {
  DESKTOP_APP_USER_MODEL_ID,
  DESKTOP_RELEASE_METADATA,
} from './desktop-app-identity'
import {
  initializeDesktopObservability,
  pruneExpiredNativeCrashDumpsEffect,
} from './desktop-observability'
import { anonymousNativeMetricsReporter } from './native-runtime/anonymous-metrics'
import { desktopVoiceService } from './voice/desktop-voice-service'
import {
  disposeWithinDesktopShutdownBudgetEffect,
  VOICE_SHUTDOWN_GRACE_MS,
} from './shutdown-budget'

installStdioPipeErrorHandlers()

let mainWindow: BrowserWindow | null = null
let embeddedServer: EmbeddedWebServer | null = null
let tray: Tray | null = null
let quitting = false
let desktopIpcRegistered = false
let desktopPreferences: DesktopPreferences = { ...DEFAULT_DESKTOP_PREFERENCES }
let desktopLocalSettings: DesktopLocalSettings = desktopLocalSettingsDefaults()
const desktopLocalSettingsWrite = Semaphore.makeUnsafe(1)
const appCreation = Semaphore.makeUnsafe(1)
let trayVoiceState: DesktopTrayVoiceState = 'default'
let shutdownPromise: Promise<void> | null = null
let shutdownComplete = false

const isDev = !app.isPackaged

if (isDev) {
  const devUserDataPath = process.env.SYRNIKE_DESKTOP_DEV_USER_DATA?.trim()

  app.setPath(
    'userData',
    devUserDataPath
      ? path.resolve(devUserDataPath)
      : path.join(app.getPath('appData'), 'syrnike13-desktop-dev'),
  )
}

if (process.platform === 'win32') {
  app.setAppUserModelId(DESKTOP_APP_USER_MODEL_ID)
}

function configureChromium() {
  if (process.platform === 'linux') {
    app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer')
    return
  }

  if (process.platform === 'win32') {
    app.commandLine.appendSwitch('ignore-gpu-blocklist')
    app.commandLine.appendSwitch(
      'enable-features',
      'MediaFoundationH264CbpEncoding,MediaFoundationVP9Encoding',
    )
  }
}

const resolveAppUrlEffect = Effect.fn('desktop.resolveAppUrl')(function*() {
  if (isDev) {
    return __WEB_DEV_URL__
  }

  if (embeddedServer) return embeddedServer.url

  const webDistRoot = resolveWebDistRoot()
  embeddedServer = yield* startEmbeddedWebServerEffect(webDistRoot)
  return embeddedServer.url
})

function desktopPreferencesPath() {
  return path.join(app.getPath('userData'), 'desktop-preferences.json')
}

function currentDesktopSessionPath() {
  return desktopSessionPath(app.getPath('userData'))
}

function desktopLocalSettingsPath() {
  return path.join(app.getPath('userData'), 'local-settings.json')
}

function getDesktopPreferences() {
  return desktopPreferences
}

const setCloseToTrayEffect = Effect.fn('desktop.setCloseToTray')(
  function*(closeToTray: boolean) {
    const nextPreferences = { ...desktopPreferences, closeToTray }
    yield* saveDesktopPreferencesEffect(
      desktopPreferencesPath(),
      nextPreferences,
    )
    return yield* Effect.sync(() => {
      desktopPreferences = nextPreferences
      updateTrayMenu()
      return desktopPreferences
    })
  },
)

function setCloseToTray(closeToTray: boolean) {
  return Effect.runPromise(setCloseToTrayEffect(closeToTray))
}

const setOpenAtLoginEffect = Effect.fn('desktop.setOpenAtLogin')(
  function*(openAtLogin: boolean) {
    const nextPreferences = { ...desktopPreferences, openAtLogin }
    yield* saveDesktopPreferencesEffect(
      desktopPreferencesPath(),
      nextPreferences,
    )
    return yield* Effect.sync(() => {
      desktopPreferences = nextPreferences
      applyLoginItemSettings(openAtLogin)
      return desktopPreferences
    })
  },
)

function setOpenAtLogin(openAtLogin: boolean) {
  return Effect.runPromise(setOpenAtLoginEffect(openAtLogin))
}

function saveOverlaySettings(overlay: DesktopOverlaySettings) {
  return Effect.runPromise(
    patchDesktopLocalSettingsEffect({ overlay }).pipe(Effect.asVoid),
  )
}

function applyDesktopLocalSettings(settings: DesktopLocalSettings) {
  desktopLocalSettings = settings
  if (settings.observability.diagnosticReports) {
    process.env.SYRNIKE_NATIVE_MEDIA_DIAGNOSTICS = '1'
    process.env.SYRNIKE_NATIVE_DIAGNOSTIC_ROOT_DIR = path.join(
      app.getPath('userData'),
      'logs',
      'native-media-diagnostics',
    )
  } else {
    delete process.env.SYRNIKE_NATIVE_MEDIA_DIAGNOSTICS
    delete process.env.SYRNIKE_NATIVE_DIAGNOSTIC_ROOT_DIR
  }
  desktopVoiceService.applyPreferences(settings.voice)
  anonymousNativeMetricsReporter.configure({
    enabled: settings.observability.anonymousNativeMetrics,
    endpoint: app.isPackaged ? __DESKTOP_NATIVE_METRICS_ENDPOINT__ : '',
  })
}

const patchDesktopLocalSettingsEffect = Effect.fn(
  'desktop.patchLocalSettings',
)(function*(patch: DesktopLocalSettingsPatch) {
  return yield* desktopLocalSettingsWrite.withPermit(
    Effect.gen(function*() {
      const settings = yield* updateDesktopLocalSettingsEffect(
        desktopLocalSettingsPath(),
        patch,
        desktopLocalSettingsDefaults(),
      )
      yield* Effect.sync(() => applyDesktopLocalSettings(settings))
      return settings
    }),
  )
})

function patchDesktopLocalSettings(patch: DesktopLocalSettingsPatch) {
  return Effect.runPromise(patchDesktopLocalSettingsEffect(patch))
}

const ensureAppCreated = Effect.fn('desktop.ensureAppCreated')(function*() {
  yield* appCreation.withPermit(
    Effect.suspend(() =>
      mainWindow && !mainWindow.isDestroyed() ? Effect.void : createApp(),
    ),
  )
})

function reportStartupFailure(error: unknown) {
  console.error('[desktop] failed to start', error)
  const message =
    error instanceof Error
      ? error.message
      : `Не удалось запустить ${DESKTOP_RELEASE_METADATA.displayName}.`
  dialog.showErrorBox(DESKTOP_RELEASE_METADATA.displayName, message)
  quitting = true
  app.quit()
}

function runStartupEffect(effect: Effect.Effect<unknown, unknown>) {
  Effect.runFork(
    effect.pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          reportStartupFailure(error)
        }),
      ),
    ),
  )
}

function focusMainWindow() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function showMainWindow() {
  if (!mainWindow) {
    runStartupEffect(
      ensureAppCreated().pipe(
        Effect.andThen(Effect.sync(focusMainWindow)),
      ),
    )
    return
  }
  focusMainWindow()
}

const navigateToDeepLink = Effect.fn('desktop.navigateToDeepLink')(
  function*(route: string) {
    yield* ensureAppCreated()
    yield* Effect.sync(focusMainWindow)
    const targetWindow = mainWindow
    if (!targetWindow) return
    const appUrl = yield* resolveAppUrlEffect()
    yield* Effect.tryPromise({
      try: () => targetWindow.loadURL(new URL(route, appUrl).toString()),
      catch: (cause) => cause,
    })
  },
)

function quitApp() {
  quitting = true
  app.quit()
}

function trayIcon() {
  const assetName = TRAY_ICON_ASSET_BY_STATE[trayVoiceState]
  const icon = nativeImage.createFromPath(resolveDesktopAsset(assetName))
  if (process.platform === 'darwin') icon.setTemplateImage(true)
  return icon
}

function setTrayVoiceState(state: DesktopTrayVoiceState) {
  const nextState = normalizeDesktopTrayVoiceState(state)
  if (trayVoiceState === nextState) return
  trayVoiceState = nextState
  tray?.setImage(trayIcon())
}

function updateTrayMenu() {
  if (!tray) return

  const template: MenuItemConstructorOptions[] = [
    {
      label: `Открыть ${DESKTOP_RELEASE_METADATA.displayName}`,
      click: showMainWindow,
    },
    {
      label: 'Скрыть окно',
      enabled: Boolean(mainWindow?.isVisible()),
      click: () => mainWindow?.hide(),
    },
    { type: 'separator' },
    {
      label: 'Закрывать в трей',
      type: 'checkbox',
      checked: desktopPreferences.closeToTray,
      click: (item) => {
        Effect.runFork(
          setCloseToTrayEffect(item.checked).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                console.error(
                  '[desktop] failed to save tray preference',
                  error,
                )
                updateTrayMenu()
              }),
            ),
          ),
        )
      },
    },
    { type: 'separator' },
    {
      label: 'Выйти',
      click: quitApp,
    },
  ]

  tray.setContextMenu(Menu.buildFromTemplate(template))
}

function setupTray() {
  if (tray) return
  tray = new Tray(trayIcon())
  tray.setToolTip(DESKTOP_RELEASE_METADATA.displayName)
  tray.on('click', showMainWindow)
  updateTrayMenu()
}

const createApp = Effect.fn('desktop.createApp')(function*() {
  const loadUrl = yield* resolveAppUrlEffect()
  yield* Effect.try({
    try: () => {
      initializeDesktopAutoUpdate(
        () => mainWindow,
        () => {
          quitting = true
        },
      )
      configureDesktopOverlay(loadUrl, () => mainWindow, {
        settings: desktopLocalSettings.overlay,
        persistSettings: saveOverlaySettings,
      })
      if (!desktopIpcRegistered) {
        desktopIpcRegistered = true
        registerDesktopIpc(() => mainWindow, {
          getWindowPreferences: getDesktopPreferences,
          setCloseToTray,
          setOpenAtLogin,
          setTrayVoiceState,
          updateLocalSettings: patchDesktopLocalSettings,
          showWindow: showMainWindow,
          localSettingsPath: desktopLocalSettingsPath(),
          localSettingsDefaults: desktopLocalSettingsDefaults(),
          sessionPath: currentDesktopSessionPath(),
        })
      }
      mainWindow = createMainWindow(loadUrl)
      mainWindow.on('close', (event) => {
        if (quitting || !desktopPreferences.closeToTray) return
        event.preventDefault()
        mainWindow?.hide()
        updateTrayMenu()
      })
      mainWindow.on('closed', () => {
        mainWindow = null
        updateTrayMenu()
      })
      mainWindow.on('show', updateTrayMenu)
      mainWindow.on('hide', updateTrayMenu)
      mainWindow.on('minimize', updateTrayMenu)
      mainWindow.on('restore', updateTrayMenu)
      mainWindow.once('ready-to-show', () => {
        setupTray()
      })
    },
    catch: (cause) => cause,
  })
})

function setupSingleInstance() {
  // Dev Electron shares the packaged app's single-instance mutex on Windows
  // when the installed syrnike13 client is running in the tray.
  if (isDev) return true

  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
    return false
  }

  app.on('second-instance', (_event, argv) => {
    const route = argv.map(routeFromDeepLink).find((value) => value !== null)
    if (route) runStartupEffect(navigateToDeepLink(route))
    else showMainWindow()
  })

  return true
}

const disposeAppResourcesEffect = Effect.fn('desktop.disposeResources')(
  function*() {
    const server = yield* Effect.sync(() => {
      const current = embeddedServer
      embeddedServer = null
      return current
    })
    yield* disposeWithinDesktopShutdownBudgetEffect({
      disposeVoice: desktopVoiceService.disposeEffect(),
      onVoiceDisposeError: (error) => {
        logNativeVoiceDiagnostic('dispose_failed', {
          stage: 'voice_shutdown',
          message:
            error instanceof Error ? error.message : 'Voice shutdown failed',
        })
      },
      onVoiceDeadlineExceeded: (timeoutMs) => {
        logNativeVoiceDiagnostic('dispose_deadline_exceeded', {
          stage: 'voice_shutdown',
          timeoutMs,
        })
      },
      disposeRemaining: Effect.all(
        [
          Effect.try({
            try: () => disposeDesktopAutoUpdate(),
            catch: (cause) => cause,
          }).pipe(Effect.ignore),
          Effect.gen(function*() {
            yield* Effect.sync(() => {
              disposeHotkeys()
              disposeDesktopOverlay()
            })
            yield* hooksRuntimeController.disposeEffect()
          }).pipe(Effect.ignore),
          disposeNativeMediaRuntimeEffect().pipe(Effect.ignore),
          (server ? server.closeEffect() : Effect.void).pipe(Effect.ignore),
          anonymousNativeMetricsReporter.flushEffect().pipe(
            Effect.ensuring(
              Effect.sync(() => anonymousNativeMetricsReporter.dispose()),
            ),
            Effect.ignore,
          ),
          Effect.try({
            try: () => {
              tray?.destroy()
              tray = null
            },
            catch: (cause) => cause,
          }).pipe(Effect.ignore),
        ],
        { concurrency: 'unbounded', discard: true },
      ),
      onDeadlineSettled: () => {
        anonymousNativeMetricsReporter.dispose()
      },
    })
  },
)

configureChromium()

if (setupSingleInstance()) {
  const initialDeepLinkRoute = process.argv
    .map(routeFromDeepLink)
    .find((value) => value !== null)

  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(DESKTOP_RELEASE_METADATA.protocolScheme)
  }

  app.on('open-url', (event, url) => {
    event.preventDefault()
    const route = routeFromDeepLink(url)
    if (!route) return
    runStartupEffect(navigateToDeepLink(route))
  })

  const startDesktop = Effect.fn('desktop.start')(function*() {
    yield* Effect.tryPromise({
      try: () => app.whenReady(),
      catch: (cause) => cause,
    })
    const [loadedPreferences, loadedLocalSettings] = yield* Effect.all(
      [
        loadDesktopPreferencesEffect(desktopPreferencesPath()),
        loadDesktopLocalSettingsEffect(
          desktopLocalSettingsPath(),
          desktopLocalSettingsDefaults(),
        ),
      ],
      { concurrency: 'unbounded' },
    )
    yield* Effect.sync(() => {
      desktopPreferences = loadedPreferences
      desktopLocalSettings = loadedLocalSettings
      desktopVoiceService.setPreferencePersistence((voice) =>
        Effect.runPromise(
          patchDesktopLocalSettingsEffect({ voice }).pipe(Effect.asVoid),
        ),
      )
      applyDesktopLocalSettings(desktopLocalSettings)
      initializeDesktopObservability({
        nativeCrashReportsEnabled:
          desktopLocalSettings.observability.nativeCrashReports,
      })
      applyLoginItemSettings(desktopPreferences.openAtLogin)
      startNativeMediaRuntime()
      desktopVoiceService.startSystemLifecycle()
    })
    yield* pruneExpiredNativeCrashDumpsEffect().pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          console.warn('[desktop] failed to prune expired native crash dumps')
        }),
      ),
      Effect.forkDetach,
    )
    if (initialDeepLinkRoute) {
      yield* navigateToDeepLink(initialDeepLinkRoute)
    } else {
      yield* ensureAppCreated()
    }
  })
  runStartupEffect(startDesktop())

  app.on('window-all-closed', () => {
    if (desktopPreferences.closeToTray && !quitting) return
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      runStartupEffect(ensureAppCreated())
    }
  })

  app.on('before-quit', (event) => {
    quitting = true
    if (shutdownComplete) return
    event.preventDefault()
    if (shutdownPromise) return
    shutdownPromise = Effect.runPromise(
      disposeAppResourcesEffect().pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            console.error('[desktop] shutdown failed', cause)
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            shutdownComplete = true
            app.quit()
          }),
        ),
      ),
    )
  })
}
