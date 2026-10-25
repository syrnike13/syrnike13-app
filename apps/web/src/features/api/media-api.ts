import type { Translator } from '@syrnike13/ui/i18n'
import { config } from '#/lib/config'
import { Cause, Effect, Option, Schema } from 'effect'

export type UploadProgressHandler = (progress: number) => void

export type AttachmentUploadTag = 'attachments' | 'feedback'

export type UploadAttachmentOptions = {
  /** Autumn tag; `feedback` accepts larger files than message attachments. */
  tag?: AttachmentUploadTag
  onProgress?: UploadProgressHandler
  signal?: AbortSignal
  t: Translator
}

const UploadResponseSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
})

const UploadRejectionSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('FileTooLarge'), max: Schema.Number }),
  Schema.Struct({ type: Schema.Literal('FileTypeNotAllowed') }),
])

/** Localized reason for an upload the file server rejected. */
function uploadRejectionMessage(body: unknown, t: Translator) {
  const rejection = Schema.decodeUnknownOption(UploadRejectionSchema)(body)
  if (Option.isNone(rejection)) return undefined
  return rejection.value.type === 'FileTooLarge'
    ? t('uploadTooLarge', {
        size: Math.floor(rejection.value.max / 1_000_000),
      })
    : t('uploadTypeNotAllowed')
}

type UploadRequestOptions = {
  token: string
  file: File
  endpoint: string
  failureMessage: string
  rejectionMessage?: (body: unknown) => string | undefined
  networkFailureMessage?: string
  abortMessage: string
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
          Effect.fail(
            new DOMException(options.abortMessage, 'AbortError'),
          ),
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
        settle(
          Effect.fail(
            new Error(
              options.rejectionMessage?.(xhr.response) ??
                options.failureMessage,
            ),
          ),
        )
      }
      const handleNetworkError = () =>
        settle(
          Effect.fail(
            new Error(
              options.networkFailureMessage ?? options.failureMessage,
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

function abortUpload(signal: AbortSignal, abortMessage: string) {
  return Effect.callback<never, DOMException>((resume) => {
    const onAbort = () =>
      resume(Effect.fail(new DOMException(abortMessage, 'AbortError')))
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
  abortMessage: string,
  signal?: AbortSignal,
) {
  return signal
    ? effect.pipe(Effect.raceFirst(abortUpload(signal, abortMessage)))
    : effect
}

function runUpload(
  effect: Effect.Effect<string, Error>,
  abortMessage: string,
  signal?: AbortSignal,
) {
  const interruptAsAbort = Effect.uninterruptibleMask((restore) =>
    restore(effect).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.fail(new DOMException(abortMessage, 'AbortError'))
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
    options: UploadAttachmentOptions,
  ) {
    return yield* interruptibleUpload(
      uploadFile({
        token,
        file,
        endpoint: options.tag ?? 'attachments',
        failureMessage: options.t('uploadFailed'),
        rejectionMessage: (body) => uploadRejectionMessage(body, options.t),
        networkFailureMessage: options.t('networkError'),
        abortMessage: options.t('uploadCancelled'),
        onProgress: options.onProgress,
        clampProgress: true,
      }),
      options.t('uploadCancelled'),
      options.signal,
    )
  },
)

export function uploadAttachment(
  token: string,
  file: File,
  options: UploadAttachmentOptions,
): Promise<string> {
  const effect = uploadAttachmentEffect(token, file, {
    tag: options.tag,
    onProgress: options.onProgress,
    t: options.t,
  })
  return runUpload(
    effect,
    options.t('uploadCancelled'),
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
    t: Translator,
    onProgress?: UploadProgressHandler,
  ) {
    return yield* uploadFile({
      token,
      file,
      endpoint: tag,
      failureMessage: t('uploadFailed'),
      networkFailureMessage: t('networkError'),
      abortMessage: t('uploadCancelled'),
      onProgress,
    })
  },
)

export function uploadMediaFile(
  token: string,
  tag: MediaUploadTag,
  file: File,
  t: Translator,
  onProgress?: UploadProgressHandler,
  signal?: AbortSignal,
): Promise<string> {
  return runUpload(
    uploadMediaFileEffect(token, tag, file, t, onProgress),
    t('uploadCancelled'),
    signal,
  )
}

export const uploadEmojiEffect = Effect.fn('media.uploadEmoji')(
  function*(token: string, file: File, t: Translator) {
    return yield* uploadFile({
      token,
      file,
      endpoint: 'emojis',
      failureMessage: t('emojiUploadFailed'),
      networkFailureMessage: t('networkError'),
      abortMessage: t('uploadCancelled'),
    })
  },
)

export function uploadEmoji(
  token: string,
  file: File,
  t: Translator,
  signal?: AbortSignal,
): Promise<string> {
  return runUpload(uploadEmojiEffect(token, file, t), t('uploadCancelled'), signal)
}
