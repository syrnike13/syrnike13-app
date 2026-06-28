import type { File } from '@syrnike13/api-types'

import { config } from '#/lib/config'

function attachmentPreviewUrl(file: Pick<File, '_id' | 'tag'>) {
  return `${config.mediaUrl}/${file.tag}/${file._id}`
}

export function badgeIconUrl(icon: File | null | undefined) {
  if (!icon) return null
  return attachmentPreviewUrl(icon)
}
