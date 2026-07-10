import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  IPC,
  assertLocalMediaIntent,
  type DesktopDisplayMediaRequest,
  type DesktopDisplayMediaSource,
  type LocalMediaIntent,
  type NativeMicrophonePipelineConfig,
} from '@syrnike13/platform'

import type { NativeMediaController } from './native-media-controller'
import type { NativeMediaReconciler } from './native-media-reconciler'

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
  reconciler: NativeMediaReconciler,
) {
  if (registered) return
  registered = true

  controller.subscribe((message) => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    switch (message.type) {
      case 'stats':
        win.webContents.send(IPC.mediaStats, message.event)
        return
      case 'microphoneMetrics':
        win.webContents.send(IPC.mediaMicrophoneMetrics, message.event)
        return
      case 'microphonePreviewState':
        win.webContents.send(IPC.mediaMicrophonePreviewState, message.event)
        return
      case 'state':
      case 'streamEnded':
      case 'streamError':
      case 'runtimeLost':
      case 'executionTerminal':
      case 'operationMetric':
        return
    }
  })

  reconciler.subscribe((event) => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send(IPC.mediaLocalMediaState, event)
  })

  ipcMain.handle(
    IPC.mediaApplyLocalMediaIntent,
    async (event, intent: LocalMediaIntent) => {
      assertTrusted(event, getWindow, 'apply local media intent')
      assertLocalMediaIntent(intent)
      return reconciler.applyIntent(intent)
    },
  )

  ipcMain.handle(
    IPC.mediaConfigureMicrophonePipeline,
    async (
      event,
      config: NativeMicrophonePipelineConfig,
    ) => {
      assertTrusted(event, getWindow, 'configure')
      return controller.configureMicrophonePipeline(config)
    },
  )

  ipcMain.handle(IPC.mediaListDevices, async (event, kind: 'audioinput') => {
    if (!isTrustedSender(event, getWindow)) return []
    return controller.listDevices(kind)
  })

  ipcMain.handle(
    IPC.mediaStartMicrophonePreview,
    async (event) => {
      assertTrusted(event, getWindow, 'preview')
      return controller.startMicrophonePreview()
    },
  )

  ipcMain.handle(
    IPC.mediaStopMicrophonePreview,
    async (event) => {
      if (!isTrustedSender(event, getWindow)) return
      return controller.stopMicrophonePreview()
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
