import { app, BrowserWindow, session, shell } from 'electron'

import { resolvePreloadScript } from './paths'

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

const openDevTools = process.env.SYRNIKE_OPEN_DEVTOOLS === '1'

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
    backgroundColor: '#1a1625',
    title: 'syrnike13',
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

  void win.loadURL(loadUrl)

  if (!app.isPackaged && openDevTools) {
    win.webContents.openDevTools({ mode: 'detach' })
  }

  return win
}
