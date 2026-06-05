import type { File, User } from '@syrnike13/api-types'

import { config } from '#/lib/config'

export function attachmentPreviewUrl(file: Pick<File, '_id' | 'tag'>) {
  return `${config.mediaUrl}/${file.tag}/${file._id}`
}

export function attachmentOriginalUrl(file: Pick<File, '_id' | 'tag'>) {
  return `${config.mediaUrl}/${file.tag}/${file._id}/original`
}

export function isImageFile(file: File) {
  return file.metadata.type === 'Image'
}

export function userAvatarUrl(avatar: User['avatar']) {
  if (!avatar) return null
  return attachmentPreviewUrl(avatar)
}

export function userBannerUrl(background: File | null | undefined) {
  if (!background) return null
  return attachmentPreviewUrl(background)
}

export function roleIconUrl(icon: File | null | undefined) {
  if (!icon) return null
  return attachmentPreviewUrl(icon)
}
