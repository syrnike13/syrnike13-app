import type { File } from '@syrnike13/api-types'

import { config } from '#/lib/config'

export function attachmentPreviewUrl(file: Pick<File, '_id' | 'tag'>) {
  return `${config.mediaUrl}/${file.tag}/${file._id}`
}

export function attachmentOriginalUrl(
  file: Pick<File, '_id' | 'tag' | 'filename'>,
) {
  return `${config.mediaUrl}/${file.tag}/${file._id}/${encodeURIComponent(file.filename || 'original')}`
}

export function badgeIconUrl(
  icon: Pick<File, '_id' | 'tag'> | null | undefined,
) {
  if (!icon) return null
  return attachmentPreviewUrl(icon)
}
