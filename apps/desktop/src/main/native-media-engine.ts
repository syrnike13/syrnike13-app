import type { BrowserWindow } from 'electron'

import { NativeMediaController } from './native-runtime/native-media-controller'
import {
  clearPendingNativePicker,
  getPendingNativePicker,
  registerNativeMediaIpc,
  setPendingNativePicker,
  type PendingNativePicker,
} from './native-runtime/media-ipc'
import { NativeRuntimeSupervisor } from './native-runtime/runtime-supervisor'
import {
  createElectronUtilityAdapterFactory,
  nativeRuntimeAvailable,
} from './native-runtime/utility-adapter'
import {
  attachNativeMediaSessionMetrics,
  attachNativeRuntimeMetrics,
} from './native-runtime/anonymous-metrics'

let getWindowRef: (() => BrowserWindow | null) | null = null

const supervisor = new NativeRuntimeSupervisor({
  runtime: 'media',
  createAdapter: createElectronUtilityAdapterFactory('media'),
})

const controller = new NativeMediaController({
  supervisor,
  runtimeAvailable: () => nativeRuntimeAvailable('media'),
  getSelfWindowHwnd: () => readWindowHwnd(getWindowRef?.() ?? null),
})

attachNativeRuntimeMetrics(supervisor, 'media')
attachNativeMediaSessionMetrics(controller)

export type { PendingNativePicker }
export {
  clearPendingNativePicker,
  getPendingNativePicker,
  setPendingNativePicker,
}

export function getNativeMediaController() {
  return controller
}

export function registerNativeMediaRuntimeIpc(
  getWindow: () => BrowserWindow | null,
) {
  getWindowRef = getWindow
  registerNativeMediaIpc(getWindow, controller)
}

export function startNativeMediaRuntime() {
  void controller
    .start()
    .then(() => controller.prewarmMicrophone())
    .catch((error) => {
      console.warn('[native-media] runtime prewarm failed', safeErrorMessage(error))
    })
}

export async function disposeNativeMediaRuntime() {
  await controller.dispose().catch((error) => {
    console.warn('[native-media] runtime shutdown failed', safeErrorMessage(error))
  })
}

export async function listNativeDisplaySources(
  getWindow?: () => BrowserWindow | null,
) {
  if (getWindow) getWindowRef = getWindow
  return controller.listDisplaySources()
}

function readWindowHwnd(win: BrowserWindow | null) {
  if (!win || win.isDestroyed()) return undefined
  const handle = win.getNativeWindowHandle()
  if (handle.length < 4) return undefined
  if (handle.length >= 8) return handle.readBigUInt64LE(0).toString()
  return handle.readUInt32LE(0).toString()
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Native media runtime failed'
}
