import { config } from '#/lib/config'
import { Cause, Effect, Option, Schema } from 'effect'

export type UploadProgressHandler = (progress: number) => void

export type UploadAttachmentOptions = {
  onProgress?: UploadProgressHandler
  signal?: AbortSignal
}

const UploadResponseSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
})

type UploadRequestOptions = {
  token: string
  file: File
  endpoint: string
  failureMessage: string
  networkFailureMessage?: string
  onProgress?: UploadProgressHandler
  clampProgress?: boolean
}

const uploadFile = Effect.fn('media.uploadFile')(
  function*(options: UploadRequestOptions) {
    return yield* Effect.callback<string, Error>((resume) => {
      const body = new FormData()
      body.set('file', options.file)

      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${config.mediaUrl}/${options.endpoint}`, true)
      xhr.setRequestHeader('X-Session-Token', options.token)
      xhr.responseType = 'json'

      let settled = false
      const settle = (result: Effect.Effect<string, Error>) => {
        if (settled) return
        settled = true
        resume(result)
      }
      const rejectAbort = () =>
        settle(
          Effect.fail(new DOMException('Загрузка отменена', 'AbortError')),
        )
      const handleProgress = (event: ProgressEvent) => {
        if (!event.lengthComputable || event.total <= 0) return
        const progress = event.loaded / event.total
        options.onProgress?.(
          options.clampProgress
            ? Math.min(1, Math.max(0, progress))
            : progress,
        )
      }
      const handleLoadEnd = () => {
        if (xhr.readyState === 4 && xhr.status >= 200 && xhr.status < 300) {
          const decoded = Schema.decodeUnknownOption(UploadResponseSchema)(
            xhr.response,
          )
          if (Option.isSome(decoded)) {
            settle(Effect.succeed(decoded.value.id))
            return
          }
        }
        settle(Effect.fail(new Error(options.failureMessage)))
      }
      const handleNetworkError = () =>
        settle(
          Effect.fail(
            new Error(
              options.networkFailureMessage ?? 'Ошибка сети при загрузке',
            ),
          ),
        )

      xhr.upload.addEventListener('progress', handleProgress)
      xhr.addEventListener('loadend', handleLoadEnd)
      xhr.addEventListener('error', handleNetworkError)
      xhr.addEventListener('abort', rejectAbort)

      xhr.send(body)

      return Effect.sync(() => {
        if (!settled) {
          settled = true
          xhr.abort()
        }
      })
    })
  },
)

function abortUpload(signal: AbortSignal) {
  return Effect.callback<never, DOMException>((resume) => {
    const onAbort = () =>
      resume(Effect.fail(new DOMException('Загрузка отменена', 'AbortError')))
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    return Effect.sync(() => signal.removeEventListener('abort', onAbort))
  })
}

function interruptibleUpload(
  effect: Effect.Effect<string, Error>,
  signal?: AbortSignal,
) {
  return signal ? effect.pipe(Effect.raceFirst(abortUpload(signal))) : effect
}

function runUpload(
  effect: Effect.Effect<string, Error>,
  signal?: AbortSignal,
) {
  const interruptAsAbort = Effect.uninterruptibleMask((restore) =>
    restore(effect).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.fail(new DOMException('Загрузка отменена', 'AbortError'))
          : Effect.fail(Cause.squash(cause)),
      ),
    ),
  )
  return Effect.runPromise(
    interruptAsAbort,
    signal ? { signal } : undefined,
  )
}

export const uploadAttachmentEffect = Effect.fn('media.uploadAttachment')(
  function*(
    token: string,
    file: File,
    options: UploadAttachmentOptions = {},
  ) {
    return yield* interruptibleUpload(
      uploadFile({
        token,
        file,
        endpoint: 'attachments',
        failureMessage: 'Не удалось загрузить файл',
        onProgress: options.onProgress,
        clampProgress: true,
      }),
      options.signal,
    )
  },
)

export function uploadAttachment(
  token: string,
  file: File,
  options: UploadAttachmentOptions = {},
): Promise<string> {
  const effect = uploadAttachmentEffect(token, file, {
    onProgress: options.onProgress,
  })
  return runUpload(
    effect,
    options.signal,
  )
}

export type MediaUploadTag =
  | 'avatars'
  | 'backgrounds'
  | 'icons'
  | 'banners'
  | 'badges'

export const uploadMediaFileEffect = Effect.fn('media.uploadMediaFile')(
  function*(
    token: string,
    tag: MediaUploadTag,
    file: File,
    onProgress?: UploadProgressHandler,
  ) {
    return yield* uploadFile({
      token,
      file,
      endpoint: tag,
      failureMessage: 'Не удалось загрузить файл',
      onProgress,
    })
  },
)

export function uploadMediaFile(
  token: string,
  tag: MediaUploadTag,
  file: File,
  onProgress?: UploadProgressHandler,
  signal?: AbortSignal,
): Promise<string> {
  return runUpload(
    uploadMediaFileEffect(token, tag, file, onProgress),
    signal,
  )
}

export const uploadEmojiEffect = Effect.fn('media.uploadEmoji')(
  function*(token: string, file: File) {
    return yield* uploadFile({
      token,
      file,
      endpoint: 'emojis',
      failureMessage: 'Не удалось загрузить emoji',
    })
  },
)

export function uploadEmoji(
  token: string,
  file: File,
  signal?: AbortSignal,
): Promise<string> {
  return runUpload(uploadEmojiEffect(token, file), signal)
}
