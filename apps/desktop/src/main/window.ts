import { app, BrowserWindow, session, shell } from 'electron'

import { resolvePreloadScript } from './paths'

const isMac = process.platform === 'darwin'

/** Совпадает с dark `--background` в web UI. */
const DESKTOP_WINDOW_BACKGROUND = '#3d3a48'

const desktopContentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline' https://js.hcaptcha.com https://*.hcaptcha.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' https: data: blob:",
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
    win.webContents.openDevTools({ mode: 'detach' })
  }

  return win
}
