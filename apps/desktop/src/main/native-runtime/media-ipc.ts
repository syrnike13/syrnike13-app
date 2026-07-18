import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  IPC,
  type DesktopDisplayMediaRequest,
  type DesktopDisplayMediaSource,
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
      case 'microphoneMetrics':
        win.webContents.send(IPC.mediaMicrophoneMetrics, message.event)
        return
      case 'microphonePreviewState':
        win.webContents.send(IPC.mediaMicrophonePreviewState, message.event)
        return
      case 'remoteVideoSubscriptionFailed':
        win.webContents.send(
          'syrnike-desktop:media:remote-video-subscription-failed',
          {
            sessionId: message.sessionId,
            generation: message.generation,
            trackId: message.trackId,
            message: message.message,
          },
        )
        return
    }
  })

  ipcMain.handle(
    IPC.mediaListDevices,
    async (
      event,
      kind: 'audioinput' | 'audiooutput' | 'videoinput',
    ) => {
    if (!isTrustedSender(event, getWindow)) return []
    return controller.listDevices(kind)
    },
  )

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

  ipcMain.handle(
    IPC.mediaSetRemoteVideoDemand,
    async (event, sessionId: string, generation: number, trackId: string, demanded: boolean) => {
      assertTrusted(event, getWindow, 'remote video demand')
      return controller.setRemoteVideoDemand(sessionId, generation, trackId, demanded)
    },
  )

  ipcMain.handle(
    IPC.mediaSetLocalScreenPreviewDemand,
    async (event, demand: { demanded: boolean; width: number; height: number; fps: number }) => {
      assertTrusted(event, getWindow, 'local screen preview demand')
      if (!demand || typeof demand !== 'object') {
        throw new Error('Local screen preview demand is required')
      }
      return controller.setLocalScreenPreviewDemand(demand)
    },
  )

  ipcMain.handle(
    IPC.mediaOpenDisplayPicker,
    async (event, audioRequested: boolean) => {
      assertTrusted(event, getWindow, 'picker')
      const win = getWindow()
      if (!win || win.isDestroyed()) {
        throw new Error('Desktop window is not available')
      }
      if (!(await controller.supportsNativeScreenCapture())) {
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
