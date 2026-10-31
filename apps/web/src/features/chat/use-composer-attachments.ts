import { useEffect, useRef, useState } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Cause, Effect, Exit } from 'effect'

import {
  uploadAttachmentEffect,
  type AttachmentUploadTag,
} from '@syrnike13/client/api/media-api'
import {
  createPendingFiles,
  fileForUpload,
  revokePendingFiles,
  type PendingComposerFile,
} from '#/lib/composer-files'
import { apiErrorMessage } from '#/lib/api/error-message'

export function useComposerAttachments(
  channelId?: string,
  { tag }: { tag?: AttachmentUploadTag } = {},
) {
  const t = useTranslations('media')
  const [files, setFiles] = useState<PendingComposerFile[]>([])
  const filesRef = useRef(files)
  const controllersRef = useRef(new Map<string, AbortController>())
  /** Uploads started ahead of `uploadAll` by `start`. */
  const inflightRef = useRef(new Map<string, Promise<string>>())
  /** Finished uploads, known before the state update is rendered. */
  const uploadedRef = useRef(new Map<string, string>())
  filesRef.current = files

  function abortUploads() {
    for (const controller of controllersRef.current.values()) controller.abort()
    controllersRef.current.clear()
    inflightRef.current.clear()
    uploadedRef.current.clear()
  }

  function reset() {
    abortUploads()
    revokePendingFiles(filesRef.current)
    filesRef.current = []
    setFiles([])
  }

  useEffect(() => reset(), [channelId])
  useEffect(
    () => () => {
      abortUploads()
      revokePendingFiles(filesRef.current)
    },
    [],
  )

  function append(fileList: FileList | File[]) {
    const next = createPendingFiles(fileList)
    if (next.length > 0) setFiles((current) => [...current, ...next])
  }

  function remove(id: string) {
    controllersRef.current.get(id)?.abort()
    controllersRef.current.delete(id)
    inflightRef.current.delete(id)
    uploadedRef.current.delete(id)
    const target = filesRef.current.find((file) => file.id === id)
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
    setFiles((current) => current.filter((file) => file.id !== id))
  }

  function toggleSpoiler(id: string) {
    setFiles((current) =>
      current.map((file) =>
        file.id === id ? { ...file, spoiler: !file.spoiler } : file,
      ),
    )
  }

  function uploadOne(token: string, pending: PendingComposerFile) {
    const controller = new AbortController()
    controllersRef.current.set(pending.id, controller)

    return Effect.gen(function*() {
      yield* Effect.sync(() => {
        setFiles((current) =>
          current.map((file) =>
            file.id === pending.id
              ? {
                  ...file,
                  status: 'uploading',
                  progress: 0,
                  error: undefined,
                }
              : file,
          ),
        )
      })

      const attachmentId = yield* uploadAttachmentEffect(
        token,
        fileForUpload(pending),
        {
          tag,
          signal: controller.signal,
          t,
          onProgress: (progress) => {
            setFiles((current) =>
              current.map((file) =>
                file.id === pending.id ? { ...file, progress } : file,
              ),
            )
          },
        },
      ).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            const message =
              error instanceof DOMException && error.name === 'AbortError'
                ? t('uploadCancelled')
                : apiErrorMessage(error, t('uploadFailed'))
            setFiles((current) =>
              current.map((file) =>
                file.id === pending.id
                  ? { ...file, status: 'error', error: message }
                  : file,
              ),
            )
          }),
        ),
      )

      yield* Effect.sync(() => {
        if (controllersRef.current.get(pending.id) === controller) {
          uploadedRef.current.set(pending.id, attachmentId)
        }
        setFiles((current) =>
          current.map((file) =>
            file.id === pending.id
              ? {
                  ...file,
                  attachmentId,
                  progress: 1,
                  status: 'uploaded',
                }
              : file,
          ),
        )
      })

      return attachmentId
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (controllersRef.current.get(pending.id) === controller) {
            controllersRef.current.delete(pending.id)
          }
        }),
      ),
    )
  }

  /** Start uploading files that were added but not uploaded yet. */
  function start(token: string) {
    for (const pending of filesRef.current) {
      if (pending.status !== 'pending' || inflightRef.current.has(pending.id)) {
        continue
      }
      const upload = Effect.runPromise(uploadOne(token, pending))
      inflightRef.current.set(pending.id, upload)
      upload
        .catch(() => undefined)
        .finally(() => {
          if (inflightRef.current.get(pending.id) === upload) {
            inflightRef.current.delete(pending.id)
          }
        })
    }
  }

  function runUploads(token: string) {
    return Effect.gen(function*() {
      const results = yield* Effect.all(
        filesRef.current.map((pending) => {
          const attachmentId =
            pending.attachmentId ?? uploadedRef.current.get(pending.id)
          if (attachmentId) {
            return Effect.succeed(attachmentId).pipe(Effect.exit)
          }

          const inflight = inflightRef.current.get(pending.id)
          if (inflight) {
            return Effect.tryPromise({
              try: () => inflight,
              catch: (error) =>
                error instanceof Error ? error : new Error(String(error)),
            }).pipe(Effect.exit)
          }

          return uploadOne(token, pending).pipe(Effect.exit)
        }),
        { concurrency: 'unbounded' },
      )

      const attachmentIds: string[] = []
      for (const result of results) {
        if (Exit.isFailure(result)) {
          return yield* Effect.fail(Cause.squash(result.cause))
        }
        attachmentIds.push(result.value)
      }
      return attachmentIds
    })
  }

  function uploadAll(token: string) {
    return runUploads(token)
  }

  return { files, append, remove, toggleSpoiler, reset, start, uploadAll }
}
