import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import {
  IPC,
  type NativeMediaRuntimeState,
} from '@syrnike13/platform'
import { Effect } from 'effect'

import {
  NATIVE_MEDIA_UNAVAILABLE_FAILURE,
  NativeMediaUnavailableError,
  NativeRtcEngineAdapter,
} from './voice/native-rtc-engine-adapter'

export const NATIVE_MEDIA_UNAVAILABLE_STATE: NativeMediaRuntimeState = {
  available: false,
  status: 'unavailable',
  restartCount: 0,
  failure: NATIVE_MEDIA_UNAVAILABLE_FAILURE,
}

let registered = false

function isTrustedSender(
  event: IpcMainInvokeEvent,
  getWindow: () => BrowserWindow | null,
) {
  const win = getWindow()
  return Boolean(win && !win.isDestroyed() && event.sender === win.webContents)
}

function assertTrustedSender(
  event: IpcMainInvokeEvent,
  getWindow: () => BrowserWindow | null,
) {
  if (!isTrustedSender(event, getWindow)) {
    throw new Error('Untrusted native media IPC sender')
  }
}

function unavailableError() {
  return NativeMediaUnavailableError.make({
    message: NATIVE_MEDIA_UNAVAILABLE_FAILURE.message,
    failure: NATIVE_MEDIA_UNAVAILABLE_FAILURE,
  })
}

export function createNativeRtcEngineAdapter() {
  return new NativeRtcEngineAdapter()
}

export function logNativeVoiceDiagnostic(event: string, data?: unknown) {
  console.info(`[desktop-voice] ${event}`, data ?? '')
}

export const flushNativeMediaDiagnosticsEffect = Effect.fn(
  'nativeMediaUnavailable.flushDiagnostics',
)(function*() {
  return yield* Effect.void
})

/**
 * Keeps the renderer contract finite while the native v2 engine is absent.
 * No handler loads an addon, forks a utility process, or schedules recovery.
 */
export function registerNativeMediaRuntimeIpc(
  getWindow: () => BrowserWindow | null,
) {
  if (registered) return
  registered = true

  ipcMain.handle(IPC.mediaGetRuntimeState, (event) => {
    assertTrustedSender(event, getWindow)
    return NATIVE_MEDIA_UNAVAILABLE_STATE
  })
  ipcMain.handle(IPC.mediaRetryRuntime, (event) => {
    assertTrustedSender(event, getWindow)
    return NATIVE_MEDIA_UNAVAILABLE_STATE
  })
  ipcMain.handle(IPC.mediaListDevices, (event) => {
    if (!isTrustedSender(event, getWindow)) return []
    return []
  })
  ipcMain.handle(IPC.mediaStartMicrophonePreview, (event) => {
    assertTrustedSender(event, getWindow)
    throw unavailableError()
  })
  ipcMain.handle(IPC.mediaStopMicrophonePreview, (event) => {
    assertTrustedSender(event, getWindow)
  })
  ipcMain.handle(IPC.mediaOpenDisplayPicker, (event) => {
    assertTrustedSender(event, getWindow)
    throw unavailableError()
  })
  ipcMain.handle(IPC.mediaSetRemoteVideoDemand, (event) => {
    assertTrustedSender(event, getWindow)
  })
  ipcMain.handle(IPC.mediaReplayRemoteVideoPublications, (event) => {
    assertTrustedSender(event, getWindow)
  })
  ipcMain.handle(IPC.mediaSetLocalScreenPreviewDemand, (event) => {
    assertTrustedSender(event, getWindow)
  })
}
