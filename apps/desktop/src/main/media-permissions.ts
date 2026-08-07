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
import { Effect, Fiber, Schema } from 'effect'

import { decodeIpcInput } from './ipc-schema'
import {
  clearPendingNativePicker,
  getPendingNativePicker,
  listNativeDisplaySourcesEffect,
  setPendingNativePicker,
} from './native-media-engine'

type DisplayMediaHandler = NonNullable<
  Parameters<Session['setDisplayMediaRequestHandler']>[0]
>
type DisplayMediaCallback = Parameters<DisplayMediaHandler>[1]

type PendingDisplayMediaRequest = {
  id: string
  audioRequested: boolean
  callback: DisplayMediaCallback
  sources: DesktopCapturerSource[]
  timeout: Fiber.Fiber<void, never>
}

const DISPLAY_MEDIA_REQUEST_TIMEOUT_MS = 120_000
const DISPLAY_MEDIA_THUMBNAIL_SIZE = { width: 320, height: 180 }

let mediaPermissionsInstalledForOrigin: string | null = null
let displayMediaIpcRegistered = false
let pendingDisplayMediaRequest: PendingDisplayMediaRequest | null = null

function isScreenCaptureSource(sourceId: string) {
  return sourceId.startsWith('screen:')
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
  if (id.startsWith('game:')) return 'game'
  return id.startsWith('screen:') ? 'screen' : 'window'
}

export function shouldAllowBrowserDisplayMediaFallback(
  platform: NodeJS.Platform,
) {
  return platform !== 'win32'
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
  Effect.runFork(Fiber.interrupt(pendingDisplayMediaRequest.timeout))
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

const loadSourcesForRequestEffect = Effect.fn(
  'desktopMedia.loadDisplaySources',
)(function*(
  requestId: string,
  sourcesRef: { sources: DesktopCapturerSource[] },
) {
  const sources = yield* Effect.tryPromise({
    try: () =>
      desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: DISPLAY_MEDIA_THUMBNAIL_SIZE,
        fetchWindowIcons: true,
      }),
    catch: (cause) => cause,
  })
  yield* Effect.sync(() => {
    sourcesRef.sources = sources
  })
  return sources.map(serializeDisplayMediaSource)
})

const refreshPendingDisplayMediaSourcesEffect = Effect.fn(
  'desktopMedia.refreshDisplaySources',
)(function*(requestId: string) {
  const pending = pendingDisplayMediaRequest
  if (!pending || pending.id !== requestId) return []
  return yield* loadSourcesForRequestEffect(requestId, pending)
})

const refreshPendingNativePickerSourcesEffect = Effect.fn(
  'desktopMedia.refreshNativePickerSources',
)(function*(
  requestId: string,
  getWindow: () => BrowserWindow | null,
) {
  const pending = getPendingNativePicker()
  if (!pending || pending.id !== requestId) return []
  const sources = yield* listNativeDisplaySourcesEffect(getWindow)
  yield* Effect.sync(() => {
    pending.sources = sources
  })
  return sources
})

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

  ipcMain.handle(IPC.mediaGetDisplaySources, (event, input: unknown) => {
    if (!isTrustedSender(event, getWindow)) return []
    const requestId = decodeIpcInput(
      IPC.mediaGetDisplaySources,
      'requestId',
      Schema.String,
      input,
    )
    const nativePending = getPendingNativePicker()
    return Effect.runPromise(
      nativePending?.id === requestId
        ? refreshPendingNativePickerSourcesEffect(requestId, getWindow)
        : refreshPendingDisplayMediaSourcesEffect(requestId),
    )
  })

  ipcMain.handle(
    IPC.mediaSelectDisplaySource,
    (
      event,
      requestInput: unknown,
      sourceInput: unknown,
      audioInput?: unknown,
    ) => {
      if (!isTrustedSender(event, getWindow)) return false
      const requestId = decodeIpcInput(
        IPC.mediaSelectDisplaySource,
        'requestId',
        Schema.String,
        requestInput,
      )
      const sourceId = decodeIpcInput(
        IPC.mediaSelectDisplaySource,
        'sourceId',
        Schema.String,
        sourceInput,
      )
      const audioRequested =
        audioInput === undefined
          ? undefined
          : decodeIpcInput(
              IPC.mediaSelectDisplaySource,
              'audioRequested',
              Schema.Boolean,
              audioInput,
            )

      const nativePending = getPendingNativePicker()
      if (nativePending?.id === requestId) {
        const source = nativePending.sources.find(
          (candidate) => candidate.id === sourceId,
        )
        if (!source) return false

        clearPendingNativePicker()

        const win = getWindow()
        if (!win || win.isDestroyed()) return false

        const selectedAudioRequested =
          (typeof audioRequested === 'boolean'
            ? audioRequested
            : nativePending.audioRequested) &&
          source.audioAvailable !== false

        win.webContents.send(IPC.mediaDisplayPickerResolved, {
          requestId,
          sourceId,
          audioRequested: selectedAudioRequested,
        })
        return true
      }

      return selectPendingDisplayMediaSource(requestId, sourceId)
    },
  )

  ipcMain.handle(IPC.mediaCancelRequest, (event, input: unknown) => {
    if (!isTrustedSender(event, getWindow)) return
    const requestId = decodeIpcInput(
      IPC.mediaCancelRequest,
      'requestId',
      Schema.String,
      input,
    )

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
    if (!shouldAllowBrowserDisplayMediaFallback(process.platform)) {
      callback({})
      return
    }

    if (!isAllowedMediaOrigin(loadUrl, request.securityOrigin)) {
      callback({})
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
    const timeout = Effect.runFork(
      Effect.sleep(DISPLAY_MEDIA_REQUEST_TIMEOUT_MS).pipe(
        Effect.andThen(
          Effect.sync(() => {
            const pending = pendingDisplayMediaRequest
            if (!pending || pending.id !== displayRequest.id) return
            pendingDisplayMediaRequest = null
            pending.callback({})
          }),
        ),
      ),
    )

    pendingDisplayMediaRequest = {
      ...displayRequest,
      callback,
      sources: [],
      timeout,
    }

    win.webContents.send(IPC.mediaRequest, displayRequest)
  })
}
