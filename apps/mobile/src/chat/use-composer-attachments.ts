import { uploadAttachment, type UploadFile } from '@syrnike13/client/api/media-api'
import { randomUuid } from '@syrnike13/client/lib/random-uuid'
import { useTranslations } from '@syrnike13/ui/i18n'
import * as DocumentPicker from 'expo-document-picker'
import { useEffect, useRef, useState } from 'react'

import { useSession } from '../auth/session-context'

/** The backend's default `message_attachments` limit (Syrnike.toml). */
export const MAX_ATTACHMENTS = 5

export type PendingAttachment = {
  id: string
  name: string
  /** Local URI for the thumbnail of an image. */
  previewUri: string | null
  progress: number
  attachmentId: string | null
  error: string | null
}

/**
 * Files picked for the next message. Each starts uploading as soon as it is
 * picked, so sending only has to wait for the slowest one.
 */
export function useComposerAttachments() {
  const t = useTranslations('mobile.media')
  const { session } = useSession()
  const [pending, setPending] = useState<PendingAttachment[]>([])
  const controllers = useRef(new Map<string, AbortController>())

  useEffect(() => {
    const active = controllers.current
    return () => active.forEach((controller) => controller.abort())
  }, [])

  function update(id: string, patch: Partial<PendingAttachment>) {
    setPending((list) => list.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  function upload(id: string, file: UploadFile) {
    const controller = new AbortController()
    controllers.current.set(id, controller)
    uploadAttachment(session.token, file, {
      t,
      signal: controller.signal,
      onProgress: (progress) => update(id, { progress }),
    })
      .then((attachmentId) => update(id, { attachmentId, progress: 1 }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        update(id, { error: error instanceof Error ? error.message : t('uploadFailed') })
      })
      .finally(() => controllers.current.delete(id))
  }

  async function pick() {
    const room = MAX_ATTACHMENTS - pending.length
    if (room <= 0) return
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
    if (result.canceled) return
    for (const asset of result.assets.slice(0, room)) {
      const id = randomUuid()
      const type = asset.mimeType ?? 'application/octet-stream'
      setPending((list) => [
        ...list,
        {
          id,
          name: asset.name,
          previewUri: type.startsWith('image/') ? asset.uri : null,
          progress: 0,
          attachmentId: null,
          error: null,
        },
      ])
      // In the browser the picker hands over the File itself.
      upload(id, asset.file ?? { uri: asset.uri, name: asset.name, type })
    }
  }

  function remove(id: string) {
    controllers.current.get(id)?.abort()
    setPending((list) => list.filter((item) => item.id !== id))
  }

  return {
    pending,
    pick,
    remove,
    clear: () => setPending([]),
    canPick: pending.length < MAX_ATTACHMENTS,
    uploading: pending.some((item) => !item.attachmentId && !item.error),
    failed: pending.some((item) => item.error),
    attachmentIds: pending.flatMap((item) => (item.attachmentId ? [item.attachmentId] : [])),
  }
}
