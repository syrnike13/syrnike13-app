import { useEffect, useRef, useState } from 'react'

import { uploadAttachment } from '#/features/api/media-api'
import {
  createPendingFiles,
  revokePendingFiles,
  type PendingComposerFile,
} from '#/lib/composer-files'

export function useComposerAttachments(channelId?: string) {
  const [files, setFiles] = useState<PendingComposerFile[]>([])
  const filesRef = useRef(files)
  const controllersRef = useRef(new Map<string, AbortController>())
  const uploadPromiseRef = useRef<Promise<string[]> | null>(null)
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

  async function runUploads(token: string) {
    const results = await Promise.allSettled(
      filesRef.current.map(async (pending) => {
        if (pending.attachmentId) return pending.attachmentId

        const controller = new AbortController()
        controllersRef.current.set(pending.id, controller)
        setFiles((current) =>
          current.map((file) =>
            file.id === pending.id
              ? { ...file, status: 'uploading', progress: 0, error: undefined }
              : file,
          ),
        )

        try {
          const attachmentId = await uploadAttachment(token, pending.file, {
            signal: controller.signal,
            onProgress: (progress) => {
              setFiles((current) =>
                current.map((file) =>
                  file.id === pending.id ? { ...file, progress } : file,
                ),
              )
            },
          })
          setFiles((current) =>
            current.map((file) =>
              file.id === pending.id
                ? { ...file, attachmentId, progress: 1, status: 'uploaded' }
                : file,
            ),
          )
          return attachmentId
        } catch (error) {
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
          throw error
        } finally {
          controllersRef.current.delete(pending.id)
        }
      }),
    )

    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (failed) throw failed.reason

    return results.map(
      (result) => (result as PromiseFulfilledResult<string>).value,
    )
  }

  function uploadAll(token: string) {
    if (uploadPromiseRef.current) return uploadPromiseRef.current

    const promise = runUploads(token).finally(() => {
      if (uploadPromiseRef.current === promise) uploadPromiseRef.current = null
    })
    uploadPromiseRef.current = promise
    return promise
  }

  return { files, append, remove, reset, uploadAll }
}
