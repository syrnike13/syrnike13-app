import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  IPC,
  LocalScreenPreviewDemandSchema,
  NativeMediaDeviceKindSchema,
  RemoteVideoDemandSchema,
  type DesktopDisplayMediaRequest,
  type DesktopDisplayMediaSource,
} from '@syrnike13/platform'
import { Effect, Fiber, Schema } from 'effect'

import type { NativeMediaController } from './native-media-controller'
import { decodeIpcInput } from '../ipc-schema'

const NATIVE_PICKER_TIMEOUT_MS = 120_000

export type PendingNativePicker = {
  id: string
  audioRequested: boolean
  sources: DesktopDisplayMediaSource[]
  timeout: Fiber.Fiber<void, never>
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
  Effect.runFork(Fiber.interrupt(pendingPicker.timeout))
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
      case 'runtimeState':
        win.webContents.send(IPC.mediaRuntimeStateChanged, message.state)
        return
      case 'microphoneMetrics':
        win.webContents.send(IPC.mediaMicrophoneMetrics, message.event)
        return
      case 'microphonePreviewState':
        win.webContents.send(IPC.mediaMicrophonePreviewState, message.event)
        return
      case 'remoteVideoSessionReset':
        win.webContents.send(IPC.mediaRemoteVideoSessionReset, {
          sessionId: message.sessionId,
          generation: message.generation,
        })
        return
      case 'remoteVideoDemandFailed':
        win.webContents.send(IPC.mediaRemoteVideoFailed, message)
        return
    }
  })

  ipcMain.handle(IPC.mediaGetRuntimeState, async (event) => {
    assertTrusted(event, getWindow, 'runtime state')
    return controller.getRuntimeState()
  })

  ipcMain.handle(IPC.mediaRetryRuntime, async (event) => {
    assertTrusted(event, getWindow, 'runtime retry')
    return controller.retryRuntime()
  })

  ipcMain.handle(
    IPC.mediaListDevices,
    async (event, input: unknown) => {
      if (!isTrustedSender(event, getWindow)) return []
      const kind = decodeIpcInput(
        IPC.mediaListDevices,
        'kind',
        NativeMediaDeviceKindSchema,
        input,
      )
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
    async (
      event,
      sessionInput: unknown,
      generationInput: unknown,
      trackInput: unknown,
      demandedInput: unknown,
    ) => {
      assertTrusted(event, getWindow, 'remote video demand')
      const demand = decodeIpcInput(
        IPC.mediaSetRemoteVideoDemand,
        'demand',
        RemoteVideoDemandSchema,
        {
          sessionId: sessionInput,
          generation: generationInput,
          trackId: trackInput,
          demanded: demandedInput,
        },
      )
      return controller.setRemoteVideoDemand(
        demand.sessionId,
        demand.generation,
        demand.trackId,
        demand.demanded,
      )
    },
  )

  ipcMain.handle(
    IPC.mediaReplayRemoteVideoPublications,
    async (event) => {
      assertTrusted(event, getWindow, 'remote video publication replay')
      for (const publication of controller.listRemoteVideoPublications()) {
        event.sender.send(
          'syrnike-desktop:media:remote-video-publication-available',
          publication,
        )
      }
    },
  )

  ipcMain.handle(
    IPC.mediaSetLocalScreenPreviewDemand,
    async (event, input: unknown) => {
      assertTrusted(event, getWindow, 'local screen preview demand')
      const demand = decodeIpcInput(
        IPC.mediaSetLocalScreenPreviewDemand,
        'demand',
        LocalScreenPreviewDemandSchema,
        input,
      )
      return controller.setLocalScreenPreviewDemand(demand)
    },
  )

  ipcMain.handle(
    IPC.mediaOpenDisplayPicker,
    async (event, input: unknown) => {
      assertTrusted(event, getWindow, 'picker')
      const audioRequested = decodeIpcInput(
        IPC.mediaOpenDisplayPicker,
        'audioRequested',
        Schema.Boolean,
        input,
      )
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
        audioRequested,
        nativeVideo: true,
      }
      const timeout = Effect.runFork(
        Effect.sleep(NATIVE_PICKER_TIMEOUT_MS).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (pendingPicker?.id === request.id) pendingPicker = null
            }),
          ),
        ),
      )
      pendingPicker = {
        id: request.id,
        audioRequested: request.audioRequested,
        sources: [],
        timeout,
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
