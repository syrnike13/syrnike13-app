import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@syrnike13/platform'

import type {
  HotkeyActivationEvent,
  HotkeyAction,
  HotkeyBinding,
  NativeInputEvent,
  SyrnikeDesktopApi,
} from '@syrnike13/platform'

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
  hotkeys: {
    getBindings() {
      return ipcRenderer.invoke(IPC.hotkeysGetBindings)
    },
    setBindings(bindings: HotkeyBinding[]) {
      return ipcRenderer.invoke(IPC.hotkeysSetBindings, bindings)
    },
    setSuspended(suspended: boolean) {
      return ipcRenderer.invoke(IPC.hotkeysSetSuspended, suspended)
    },
    startRecording() {
      return ipcRenderer.invoke(IPC.hotkeysStartRecording)
    },
    stopRecording() {
      return ipcRenderer.invoke(IPC.hotkeysStopRecording)
    },
    getRuntimeStatus() {
      return ipcRenderer.invoke(IPC.hotkeysGetRuntimeStatus)
    },
    onRecordedInput(handler: (event: NativeInputEvent) => void) {
      const listener = (_event: Electron.IpcRendererEvent, input: unknown) => {
        if (input && typeof input === 'object') handler(input as NativeInputEvent)
      }
      ipcRenderer.on(IPC.hotkeysRecordedInput, listener)
      return () => {
        ipcRenderer.removeListener(IPC.hotkeysRecordedInput, listener)
      }
    },
    onPressed(handler: (event: HotkeyActivationEvent) => void) {
      const listener = (_event: Electron.IpcRendererEvent, input: unknown) => {
        if (isHotkeyActivationEvent(input)) handler(input)
      }
      ipcRenderer.on(IPC.hotkeysPressed, listener)
      return () => {
        ipcRenderer.removeListener(IPC.hotkeysPressed, listener)
      }
    },
  },
}

contextBridge.exposeInMainWorld('syrnikeDesktop', syrnikeDesktop)

function isHotkeyActivationEvent(value: unknown): value is HotkeyActivationEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as HotkeyActivationEvent
  return (
    typeof event.action === 'string' &&
    (event.phase === 'pressed' || event.phase === 'released')
  )
}
