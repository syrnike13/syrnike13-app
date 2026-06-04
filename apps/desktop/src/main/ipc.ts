import { app, ipcMain, type BrowserWindow } from 'electron'
import { IPC, type ActivityDetails } from '@syrnike13/platform'

let lastActivity: ActivityDetails | null = null

export function registerDesktopIpc(getWindow: () => BrowserWindow | null) {
  ipcMain.handle(IPC.versions, () => ({
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }))

  ipcMain.on(IPC.windowMinimize, () => {
    getWindow()?.minimize()
  })

  ipcMain.on(IPC.windowMaximize, () => {
    const win = getWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  ipcMain.on(IPC.windowClose, () => {
    getWindow()?.close()
  })

  ipcMain.handle(IPC.windowIsMaximized, () => getWindow()?.isMaximized() ?? false)

  ipcMain.handle(IPC.activitySet, (_event, details: ActivityDetails | null) => {
    lastActivity = details
    // TODO: Discord RPC / macOS Now Playing — подключить нативный модуль.
    if (details) {
      console.info('[desktop] activity set', details)
    } else {
      console.info('[desktop] activity cleared')
    }
  })

  ipcMain.handle(IPC.activityClear, () => {
    lastActivity = null
    console.info('[desktop] activity cleared')
  })

  return () => {
    lastActivity = null
  }
}

export function getLastActivity() {
  return lastActivity
}
