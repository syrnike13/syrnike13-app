import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@syrnike13/platform'

import type { SyrnikeDesktopApi } from '@syrnike13/platform'

const syrnikeDesktop: SyrnikeDesktopApi = {
  runtime: 'desktop',
  getVersions() {
    return ipcRenderer.invoke(IPC.versions)
  },
  window: {
    minimize() {
      ipcRenderer.send(IPC.windowMinimize)
    },
    maximize() {
      ipcRenderer.send(IPC.windowMaximize)
    },
    close() {
      ipcRenderer.send(IPC.windowClose)
    },
    isMaximized() {
      return ipcRenderer.invoke(IPC.windowIsMaximized)
    },
  },
  activity: {
    set(details) {
      return ipcRenderer.invoke(IPC.activitySet, details)
    },
    clear() {
      return ipcRenderer.invoke(IPC.activityClear)
    },
  },
}

contextBridge.exposeInMainWorld('syrnikeDesktop', syrnikeDesktop)
