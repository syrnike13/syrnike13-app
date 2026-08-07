import { config } from '#/lib/config'
import { Effect, Option, Schema } from 'effect'

export type UploadProgressHandler = (progress: number) => void

export type MediaUploadTag = 'avatars' | 'backgrounds' | 'badges'

const UploadResponseSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
})

export const uploadMediaFileEffect = Effect.fn('admin.media.uploadFile')(
  function*(
    token: string,
    tag: MediaUploadTag,
    file: File,
    onProgress?: UploadProgressHandler,
  ) {
    return yield* Effect.callback<string, Error>((resume) => {
      const body = new FormData()
      body.set('file', file)

      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${config.mediaUrl}/${tag}`, true)
      xhr.setRequestHeader('X-Session-Token', token)
      xhr.responseType = 'json'

      let settled = false
      const settle = (result: Effect.Effect<string, Error>) => {
        if (settled) return
        settled = true
        resume(result)
      }
      const handleProgress = (event: ProgressEvent) => {
        if (event.lengthComputable && event.total > 0) {
          onProgress?.(event.loaded / event.total)
        }
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
        settle(Effect.fail(new Error('Не удалось загрузить файл')))
      }
      const handleNetworkError = () =>
        settle(Effect.fail(new Error('Ошибка сети при загрузке')))

      xhr.upload.addEventListener('progress', handleProgress)
      xhr.addEventListener('loadend', handleLoadEnd)
      xhr.addEventListener('error', handleNetworkError)
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

export function uploadMediaFile(
  token: string,
  tag: MediaUploadTag,
  file: File,
  onProgress?: UploadProgressHandler,
  signal?: AbortSignal,
): Promise<string> {
  return Effect.runPromise(
    uploadMediaFileEffect(token, tag, file, onProgress),
    { signal },
  )
}
