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
  type DesktopDisplayMediaSourcePage,
  type DesktopDisplayMediaSourceType,
} from '@syrnike13/platform'
import { Effect, Fiber, Schema } from 'effect'

import { decodeIpcInput } from './ipc-schema'

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
const DISPLAY_SOURCE_PAGE_SIZE = 24

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

export function displayMediaSourcePage<Source>(
  sources: readonly Source[],
  page: number,
): {
  sources: Source[]
  page: number
  hasPrevious: boolean
  hasNext: boolean
} {
  const start = page * DISPLAY_SOURCE_PAGE_SIZE
  return {
    sources: sources.slice(start, start + DISPLAY_SOURCE_PAGE_SIZE),
    page,
    hasPrevious: page > 0,
    hasNext: sources.length > start + DISPLAY_SOURCE_PAGE_SIZE,
  }
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
  page: number,
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
  return displayMediaSourcePage(
    sources.map(serializeDisplayMediaSource),
    page,
  )
})

const refreshPendingDisplayMediaSourcesEffect = Effect.fn(
  'desktopMedia.refreshDisplaySources',
)(function*(requestId: string, page: number) {
  const pending = pendingDisplayMediaRequest
  if (!pending || pending.id !== requestId) {
    return displayMediaSourcePage<DesktopDisplayMediaSource>([], page)
  }
  const result = yield* loadSourcesForRequestEffect(requestId, page, pending)
  return pendingDisplayMediaRequest === pending
    ? result
    : displayMediaSourcePage<DesktopDisplayMediaSource>([], page)
})

function pendingDisplayMediaSourceVisual(requestId: string, sourceId: string) {
  const pending = pendingDisplayMediaRequest
  if (!pending || pending.id !== requestId) return null
  const source = pending.sources.find((candidate) => candidate.id === sourceId)
  return source ? serializeDisplayMediaSource(source) : null
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

  ipcMain.handle(IPC.mediaGetDisplaySources, (
    event,
    requestInput: unknown,
    pageInput: unknown,
  ): Promise<DesktopDisplayMediaSourcePage> | DesktopDisplayMediaSourcePage => {
    if (!isTrustedSender(event, getWindow)) {
      return displayMediaSourcePage<DesktopDisplayMediaSource>([], 0)
    }
    const requestId = decodeIpcInput(
      IPC.mediaGetDisplaySources,
      'requestId',
      Schema.String,
      requestInput,
    )
    const page = decodeIpcInput(
      IPC.mediaGetDisplaySources,
      'page',
      Schema.Natural,
      pageInput,
    )
    return Effect.runPromise(
      refreshPendingDisplayMediaSourcesEffect(requestId, page),
    )
  })

  ipcMain.handle(IPC.mediaGetDisplaySourceVisual, (
    event,
    requestInput: unknown,
    sourceInput: unknown,
  ) => {
    if (!isTrustedSender(event, getWindow)) return null
    const requestId = decodeIpcInput(
      IPC.mediaGetDisplaySourceVisual,
      'requestId',
      Schema.String,
      requestInput,
    )
    const sourceId = decodeIpcInput(
      IPC.mediaGetDisplaySourceVisual,
      'sourceId',
      Schema.String,
      sourceInput,
    )
    return pendingDisplayMediaSourceVisual(requestId, sourceId)
  })

  ipcMain.handle(
    IPC.mediaSelectDisplaySource,
    (
      event,
      requestInput: unknown,
      sourceInput: unknown,
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
