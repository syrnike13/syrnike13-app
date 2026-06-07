import {
  desktopCapturer,
  ipcMain,
  session,
  type BrowserWindow,
  type DesktopCapturerSource,
  type IpcMainInvokeEvent,
  type Session,
} from 'electron'
import {
  IPC,
  type DesktopDisplayMediaRequest,
  type DesktopDisplayMediaSource,
  type DesktopDisplayMediaSourceType,
} from '@syrnike13/platform'

import {
  clearPendingNativePicker,
  getPendingNativePicker,
  setPendingNativePicker,
} from './native-capture'

type DisplayMediaHandler = NonNullable<
  Parameters<Session['setDisplayMediaRequestHandler']>[0]
>
type DisplayMediaCallback = Parameters<DisplayMediaHandler>[1]

type PendingDisplayMediaRequest = {
  id: string
  audioRequested: boolean
  callback: DisplayMediaCallback
  sources: DesktopCapturerSource[]
  timeout: ReturnType<typeof setTimeout>
}

const DISPLAY_MEDIA_REQUEST_TIMEOUT_MS = 120_000
const DISPLAY_MEDIA_THUMBNAIL_SIZE = { width: 320, height: 180 }

let mediaPermissionsInstalledForOrigin: string | null = null
let displayMediaIpcRegistered = false
let pendingDisplayMediaRequest: PendingDisplayMediaRequest | null = null
let pendingAudioLoopbackSourceId: string | null = null

function isScreenCaptureSource(sourceId: string) {
  return sourceId.startsWith('screen:')
}

export function rememberNativeAudioLoopbackSource(sourceId: string | null) {
  if (sourceId && isScreenCaptureSource(sourceId)) {
    pendingAudioLoopbackSourceId = sourceId
    return
  }
  pendingAudioLoopbackSourceId = null
}

export function clearNativeAudioLoopbackSource() {
  pendingAudioLoopbackSourceId = null
}

function originFromUrl(value: string | null | undefined) {
  if (!value) return null
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

export function isAllowedMediaOrigin(
  appUrl: string,
  requestingOrigin: string | null | undefined,
) {
  const appOrigin = originFromUrl(appUrl)
  const origin = originFromUrl(requestingOrigin)
  return appOrigin != null && origin === appOrigin
}

export function shouldGrantDesktopMediaPermission(
  appUrl: string,
  permission: string,
  requestingOrigin: string | null | undefined,
) {
  return permission === 'media' && isAllowedMediaOrigin(appUrl, requestingOrigin)
}

export function displayMediaSourceTypeFromId(
  id: string,
): DesktopDisplayMediaSourceType {
  return id.startsWith('screen:') ? 'screen' : 'window'
}

function requestOrigin(details: {
  requestingUrl?: string
  securityOrigin?: string
}) {
  return details.securityOrigin || details.requestingUrl
}

export function isTrustedSender(
  event: IpcMainInvokeEvent,
  getWindow: () => BrowserWindow | null,
) {
  const win = getWindow()
  return Boolean(win && !win.isDestroyed() && event.sender === win.webContents)
}

function clearPendingDisplayMediaRequest() {
  if (!pendingDisplayMediaRequest) return
  clearTimeout(pendingDisplayMediaRequest.timeout)
  pendingDisplayMediaRequest = null
}

function cancelPendingDisplayMediaRequest() {
  if (!pendingDisplayMediaRequest) return
  const pending = pendingDisplayMediaRequest
  clearPendingDisplayMediaRequest()
  pending.callback({})
}

export function serializeDisplayMediaSource(
  source: DesktopCapturerSource,
): DesktopDisplayMediaSource {
  return {
    id: source.id,
    name: source.name,
    type: displayMediaSourceTypeFromId(source.id),
    thumbnailDataUrl: source.thumbnail.isEmpty()
      ? null
      : source.thumbnail.toDataURL(),
    appIconDataUrl:
      source.appIcon && !source.appIcon.isEmpty()
        ? source.appIcon.toDataURL()
        : null,
  }
}

async function loadSourcesForRequest(
  requestId: string,
  sourcesRef: { sources: DesktopCapturerSource[] },
) {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: DISPLAY_MEDIA_THUMBNAIL_SIZE,
    fetchWindowIcons: true,
  })
  sourcesRef.sources = sources
  return sources.map(serializeDisplayMediaSource)
}

async function refreshPendingDisplayMediaSources(requestId: string) {
  const pending = pendingDisplayMediaRequest
  if (!pending || pending.id !== requestId) return []
  return loadSourcesForRequest(requestId, pending)
}

async function refreshPendingNativePickerSources(requestId: string) {
  const pending = getPendingNativePicker()
  if (!pending || pending.id !== requestId) return []
  return loadSourcesForRequest(requestId, pending)
}

function selectPendingDisplayMediaSource(
  requestId: string,
  sourceId: string,
  nativeVideoOnly = false,
) {
  const pending = pendingDisplayMediaRequest
  if (!pending || pending.id !== requestId) return false

  const source = pending.sources.find((candidate) => candidate.id === sourceId)
  if (!source) return false

  clearPendingDisplayMediaRequest()
  pending.callback({
    video: nativeVideoOnly ? undefined : source,
    audio:
      pending.audioRequested &&
      process.platform === 'win32' &&
      isScreenCaptureSource(sourceId)
        ? 'loopback'
        : undefined,
  })
  return true
}

export function registerDisplayMediaIpc(getWindow: () => BrowserWindow | null) {
  if (displayMediaIpcRegistered) return
  displayMediaIpcRegistered = true

  ipcMain.handle(IPC.mediaGetDisplaySources, async (event, requestId: string) => {
    if (!isTrustedSender(event, getWindow)) return []
    const nativePending = getPendingNativePicker()
    if (nativePending?.id === requestId) {
      return refreshPendingNativePickerSources(requestId)
    }
    return refreshPendingDisplayMediaSources(requestId)
  })

  ipcMain.handle(
    IPC.mediaSelectDisplaySource,
    async (event, requestId: string, sourceId: string) => {
      if (!isTrustedSender(event, getWindow)) return false

      const nativePending = getPendingNativePicker()
      if (nativePending?.id === requestId) {
        const source = nativePending.sources.find(
          (candidate) => candidate.id === sourceId,
        )
        if (!source) return false

        clearPendingNativePicker()

        const win = getWindow()
        if (!win || win.isDestroyed()) return false

        win.webContents.send(IPC.mediaDisplayPickerResolved, {
          requestId,
          sourceId,
        })
        return true
      }

      return selectPendingDisplayMediaSource(requestId, sourceId)
    },
  )

  ipcMain.handle(IPC.mediaCancelRequest, async (event, requestId: string) => {
    if (!isTrustedSender(event, getWindow)) return

    const nativePending = getPendingNativePicker()
    if (nativePending?.id === requestId) {
      clearPendingNativePicker()
      return
    }

    const pending = pendingDisplayMediaRequest
    if (!pending || pending.id !== requestId) return
    cancelPendingDisplayMediaRequest()
  })
}

export function installMediaPermissions(
  loadUrl: string,
  getWindow: () => BrowserWindow | null,
) {
  const appOrigin = new URL(loadUrl).origin
  if (mediaPermissionsInstalledForOrigin === appOrigin) return
  mediaPermissionsInstalledForOrigin = appOrigin

  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin) =>
      shouldGrantDesktopMediaPermission(loadUrl, permission, requestingOrigin),
  )

  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      callback(
        shouldGrantDesktopMediaPermission(
          loadUrl,
          permission,
          requestOrigin(details),
        ),
      )
    },
  )

  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    if (!isAllowedMediaOrigin(loadUrl, request.securityOrigin)) {
      callback({})
      return
    }

    if (
      !request.videoRequested &&
      request.audioRequested &&
      pendingAudioLoopbackSourceId &&
      process.platform === 'win32' &&
      isScreenCaptureSource(pendingAudioLoopbackSourceId)
    ) {
      pendingAudioLoopbackSourceId = null
      callback({
        audio: 'loopback',
      })
      return
    }

    const win = getWindow()
    if (!win || win.isDestroyed()) {
      callback({})
      return
    }

    cancelPendingDisplayMediaRequest()

    const displayRequest: DesktopDisplayMediaRequest = {
      id: crypto.randomUUID(),
      audioRequested: Boolean(request.audioRequested),
      nativeVideo: false,
    }

    pendingDisplayMediaRequest = {
      ...displayRequest,
      callback,
      sources: [],
      timeout: setTimeout(
        cancelPendingDisplayMediaRequest,
        DISPLAY_MEDIA_REQUEST_TIMEOUT_MS,
      ),
    }

    win.webContents.send(IPC.mediaRequest, displayRequest)
  })
}

export function completeNativeAudioLoopback(requestId: string, sourceId: string) {
  if (!isScreenCaptureSource(sourceId)) {
    return false
  }
  return selectPendingDisplayMediaSource(requestId, sourceId, true)
}
