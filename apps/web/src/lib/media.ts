import type { File, User } from '@syrnike13/api-types'

import { config } from '#/lib/config'

type AnimatedImageFile = Pick<
  File,
  '_id' | 'tag' | 'filename' | 'metadata' | 'content_type'
>

type AnimatedMediaOptions = {
  animated?: boolean
}

type OriginalMediaFile = Pick<File, '_id' | 'tag'> & {
  filename?: string | null
}

export function attachmentPreviewUrl(file: Pick<File, '_id' | 'tag'>) {
  return `${config.mediaUrl}/${file.tag}/${file._id}`
}

export function attachmentOriginalUrl(file: OriginalMediaFile) {
  const originalName = file.filename || 'original'
  const filename = encodeURIComponent(originalName)
  return `${config.mediaUrl}/${file.tag}/${file._id}/${filename}`
}

export function isImageFile(file: File) {
  return file.metadata.type === 'Image'
}

export function isAnimatedGifFile(
  file: Pick<File, 'metadata' | 'content_type'> | null | undefined,
) {
  return (
    file?.content_type === 'image/gif' &&
    file.metadata.type === 'Image' &&
    file.metadata.animated === true
  )
}

export function animatedImageUrl(
  file: AnimatedImageFile,
  options?: AnimatedMediaOptions,
) {
  if (options?.animated && isAnimatedGifFile(file)) {
    return attachmentOriginalUrl(file)
  }

  return attachmentPreviewUrl(file)
}

export function imageFileAspectRatio(file: File): number | null {
  if (file.metadata.type !== 'Image') return null
  const { width, height } = file.metadata
  if (!width || !height) return null
  return width / height
}

export function userAvatarUrl(
  avatar: User['avatar'],
  options?: AnimatedMediaOptions,
) {
  if (!avatar) return null
  return animatedImageUrl(avatar, options)
}

export function userBannerUrl(
  background: File | null | undefined,
  options?: AnimatedMediaOptions,
) {
  if (!background) return null
  return animatedImageUrl(background, options)
}

export function roleIconUrl(icon: File | null | undefined) {
  if (!icon) return null
  return attachmentPreviewUrl(icon)
}
