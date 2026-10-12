import { useEffect, useRef, useState } from 'react'
import { Cause, Effect, Exit } from 'effect'

import { uploadAttachmentEffect } from '#/features/api/media-api'
import {
  createPendingFiles,
  fileForUpload,
  revokePendingFiles,
  type PendingComposerFile,
} from '#/lib/composer-files'

export function useComposerAttachments(channelId?: string) {
  const [files, setFiles] = useState<PendingComposerFile[]>([])
  const filesRef = useRef(files)
  const controllersRef = useRef(new Map<string, AbortController>())
  filesRef.current = files

  function abortUploads() {
    for (const controller of controllersRef.current.values()) controller.abort()
    controllersRef.current.clear()
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

  function runUploads(token: string) {
    return Effect.gen(function*() {
      const results = yield* Effect.all(
        filesRef.current.map((pending) => {
          if (pending.attachmentId) {
            return Effect.succeed(pending.attachmentId).pipe(Effect.exit)
          }

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
                signal: controller.signal,
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
                      ? 'Загрузка отменена'
                      : error instanceof Error
                        ? error.message
                        : 'Не удалось загрузить файл'
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
                controllersRef.current.delete(pending.id)
              }),
            ),
            Effect.exit,
          )
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

  return { files, append, remove, toggleSpoiler, reset, uploadAll }
}
