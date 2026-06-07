import { randomUUID } from 'node:crypto'

import { IPC, type DesktopDisplayMediaRequest } from '@syrnike13/platform'
import { ipcMain, type BrowserWindow } from 'electron'

export type PendingNativePicker = {
  id: string
  audioRequested: boolean
  sources: Electron.DesktopCapturerSource[]
}

let pendingNativePicker: PendingNativePicker | null = null
let pickerIpcRegistered = false

export function getPendingNativePicker() {
  return pendingNativePicker
}

export function clearPendingNativePicker() {
  pendingNativePicker = null
}

export function setPendingNativePickerSources(
  requestId: string,
  sources: Electron.DesktopCapturerSource[],
) {
  if (!pendingNativePicker || pendingNativePicker.id !== requestId) return false
  pendingNativePicker.sources = sources
  return true
}

export function registerMediaEnginePickerIpc(getWindow: () => BrowserWindow | null) {
  if (pickerIpcRegistered) return
  pickerIpcRegistered = true

  ipcMain.handle(
    IPC.screenShareOpenNativePicker,
    async (event, audioRequested: boolean) => {
      const win = getWindow()
      if (!win || win.isDestroyed() || event.sender !== win.webContents) {
        throw new Error('Untrusted screen share picker request')
      }

      const request: DesktopDisplayMediaRequest = {
        id: randomUUID(),
        audioRequested: Boolean(audioRequested),
        nativeVideo: true,
      }

      pendingNativePicker = {
        id: request.id,
        audioRequested: request.audioRequested,
        sources: [],
      }

      win.webContents.send(IPC.screenShareRequest, request)
      return request
    },
  )
}
