import {
  app,
  BrowserWindow,
  session,
  shell,
} from 'electron'

import { installMediaPermissions } from './media-permissions'
import { resolveDesktopAsset, resolvePreloadScript } from './paths'
import { desktopWindowIconAssetName } from './desktop-app-identity'

const isMac = process.platform === 'darwin'

/** Совпадает с dark `--background` в web UI. */
const DESKTOP_WINDOW_BACKGROUND = '#3d3a48'

const desktopContentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://js.hcaptcha.com https://*.hcaptcha.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' http://localhost:* http://127.0.0.1:* https: data: blob:",
  "media-src 'self' https: data: blob:",
  "connect-src 'self' http://localhost:* http://127.0.0.1:* https: ws: wss:",
  "frame-src 'self' https://*.hcaptcha.com",
  "worker-src 'self' blob:",
].join('; ')

let contentSecurityPolicyInstalled = false

function installContentSecurityPolicy() {
  if (contentSecurityPolicyInstalled) return
  contentSecurityPolicyInstalled = true

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = details.responseHeaders ?? {}

    callback({
      responseHeaders: {
        ...responseHeaders,
        'Content-Security-Policy': [desktopContentSecurityPolicy],
        'Cross-Origin-Opener-Policy': ['same-origin'],
        'Cross-Origin-Embedder-Policy': ['credentialless'],
      },
    })
  })
}

export function createMainWindow(loadUrl: string) {
  installContentSecurityPolicy()

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: DESKTOP_WINDOW_BACKGROUND,
    title: 'syrnike13',
    icon: resolveDesktopAsset(desktopWindowIconAssetName()),
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          // Должно совпадать с SHELL_TITLEBAR_* в shell-chrome.ts
          trafficLightPosition: { x: 12, y: 12 },
        }
      : { frame: false }),
    webPreferences: {
      preload: resolvePreloadScript(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  })

  installMediaPermissions(loadUrl, () => win)

  win.on('ready-to-show', () => {
    win.show()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  void win.loadURL(new URL('/app', loadUrl).toString())

  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'F12') return

      event.preventDefault()
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools()
      } else {
        win.webContents.openDevTools({ mode: 'detach' })
      }
    })

    if (process.env.SYRNIKE_DESKTOP_OPEN_DEVTOOLS === '1') {
      win.webContents.openDevTools({ mode: 'detach' })
    }
  }

  return win
}
