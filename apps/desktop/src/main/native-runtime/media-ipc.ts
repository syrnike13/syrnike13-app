import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  IPC,
  type DesktopDisplayMediaRequest,
  type DesktopDisplayMediaSource,
  type NativeMediaMicrophoneSessionStartOptions,
  type NativeMediaScreenSessionPrepareOptions,
  type NativeMediaSessionKind,
  type NativeMediaSessionStartOptions,
  type NativeMicrophonePreviewStartOptions,
  type NativeMicrophoneRuntimeConfig,
} from '@syrnike13/platform'

import type { NativeMediaController } from './native-media-controller'

const NATIVE_PICKER_TIMEOUT_MS = 120_000

export type PendingNativePicker = {
  id: string
  audioRequested: boolean
  sources: DesktopDisplayMediaSource[]
  timeout: ReturnType<typeof setTimeout>
}

let registered = false
let pendingPicker: PendingNativePicker | null = null

function isTrustedSender(
  event: IpcMainInvokeEvent,
  getWindow: () => BrowserWindow | null,
) {
  const win = getWindow()
  return Boolean(win && !win.isDestroyed() && event.sender === win.webContents)
}

export function getPendingNativePicker() {
  return pendingPicker
}

export function setPendingNativePicker(next: PendingNativePicker | null) {
  pendingPicker = next
}

export function clearPendingNativePicker() {
  if (!pendingPicker) return
  clearTimeout(pendingPicker.timeout)
  pendingPicker = null
}

export function registerNativeMediaIpc(
  getWindow: () => BrowserWindow | null,
  controller: NativeMediaController,
) {
  if (registered) return
  registered = true

  controller.subscribe((message) => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    switch (message.type) {
      case 'state':
        win.webContents.send(IPC.mediaStateChanged, message.event)
        return
      case 'stats':
        win.webContents.send(IPC.mediaStats, message.event)
        return
      case 'microphoneMetrics':
        win.webContents.send(IPC.mediaMicrophoneMetrics, message.event)
        return
      case 'streamEnded':
        win.webContents.send(IPC.mediaStreamEnded, message.sessionId)
        return
      case 'streamError':
        win.webContents.send(IPC.mediaStreamError, message.event)
        return
      case 'runtimeLost':
        win.webContents.send(IPC.mediaRuntimeLost, message.event)
        return
      case 'operationMetric':
        return
    }
  })

  ipcMain.handle(
    IPC.mediaPrepareScreenSession,
    async (event, options: NativeMediaScreenSessionPrepareOptions) => {
      assertTrusted(event, getWindow, 'prepare')
      return controller.prepareScreenSession(options)
    },
  )

  ipcMain.handle(IPC.mediaDisconnectPreparedScreenSession, async (event) => {
    if (!isTrustedSender(event, getWindow)) return
    return controller.disconnectPreparedScreenSession()
  })

  ipcMain.handle(
    IPC.mediaStartSession,
    async (event, options: NativeMediaSessionStartOptions) => {
      assertTrusted(event, getWindow, 'start')
      return controller.startSession(options)
    },
  )

  ipcMain.handle(
    IPC.mediaCancelPendingStarts,
    async (event, kind?: NativeMediaSessionKind) => {
      if (!isTrustedSender(event, getWindow)) return
      return controller.cancelPendingStarts(kind)
    },
  )

  ipcMain.handle(
    IPC.mediaConfigureMicrophoneRuntime,
    async (
      event,
      sessionId: string,
      config: NativeMicrophoneRuntimeConfig,
    ) => {
      assertTrusted(event, getWindow, 'configure')
      return controller.configureMicrophoneRuntime(sessionId, config)
    },
  )

  ipcMain.handle(
    IPC.mediaSetMicrophoneMuted,
    async (event, sessionId: string, muted: boolean) => {
      assertTrusted(event, getWindow, 'mute')
      return controller.setMicrophoneMuted(sessionId, Boolean(muted))
    },
  )

  ipcMain.handle(
    IPC.mediaReconnectMicrophoneSession,
    async (
      event,
      sessionId: string,
      options: NativeMediaMicrophoneSessionStartOptions,
    ) => {
      assertTrusted(event, getWindow, 'reconnect')
      return controller.reconnectMicrophoneSession(sessionId, options)
    },
  )

  ipcMain.handle(IPC.mediaStopSession, async (event, sessionId?: string) => {
    if (!isTrustedSender(event, getWindow)) return
    return controller.stopSession(sessionId)
  })

  ipcMain.handle(IPC.mediaListDevices, async (event, kind: 'audioinput') => {
    if (!isTrustedSender(event, getWindow)) return []
    return controller.listDevices(kind)
  })

  ipcMain.handle(
    IPC.mediaStartMicrophonePreview,
    async (event, options: NativeMicrophonePreviewStartOptions) => {
      assertTrusted(event, getWindow, 'preview')
      return controller.startMicrophonePreview(options)
    },
  )

  ipcMain.handle(
    IPC.mediaStopMicrophonePreview,
    async (event, sessionId?: string) => {
      if (!isTrustedSender(event, getWindow)) return
      return controller.stopMicrophonePreview(sessionId)
    },
  )

  ipcMain.handle(IPC.mediaGetState, async (event) => {
    if (!isTrustedSender(event, getWindow)) return unavailableState(controller)
    return controller.getState()
  })

  ipcMain.handle(
    IPC.mediaOpenDisplayPicker,
    async (event, audioRequested: boolean) => {
      assertTrusted(event, getWindow, 'picker')
      const win = getWindow()
      if (!win || win.isDestroyed()) {
        throw new Error('Desktop window is not available')
      }
      if (!controller.getState().engine.capabilities.screen) {
        await controller.start()
      }
      const runtimeState = controller.getState()
      if (
        !runtimeState.engine.runtime.available ||
        !runtimeState.engine.capabilities.screen
      ) {
        throw new Error('Native screen capture is not available')
      }

      clearPendingNativePicker()
      const request: DesktopDisplayMediaRequest = {
        id: crypto.randomUUID(),
        audioRequested: Boolean(audioRequested),
        nativeVideo: true,
      }
      pendingPicker = {
        id: request.id,
        audioRequested: request.audioRequested,
        sources: [],
        timeout: setTimeout(clearPendingNativePicker, NATIVE_PICKER_TIMEOUT_MS),
      }
      win.webContents.send(IPC.mediaRequest, request)
      return request
    },
  )
}

function assertTrusted(
  event: IpcMainInvokeEvent,
  getWindow: () => BrowserWindow | null,
  action: string,
) {
  if (!isTrustedSender(event, getWindow)) {
    throw new Error(`Untrusted media runtime ${action} request`)
  }
}

function unavailableState(controller: NativeMediaController) {
  const state = controller.getState()
  return {
    status: 'idle' as const,
    engine: {
      ...state.engine,
      available: false,
      runtime: {
        ...state.engine.runtime,
        available: false,
        status: 'stopped' as const,
        pid: undefined,
      },
      activeSessions: [],
      lastError: null,
    },
  }
}
