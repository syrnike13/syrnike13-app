import type { File } from '@syrnike13/api-types'

import { MEDIA_URL } from '../config'

/** Autumn serves a resized preview of any uploaded image by tag and id. */
export function mediaUrl(file: Pick<File, '_id' | 'tag'> | null | undefined) {
  return file ? `${MEDIA_URL}/${file.tag}/${file._id}` : null
}

/** The uploaded file itself, named so a download keeps its filename. */
export function attachmentOriginalUrl(file: Pick<File, '_id' | 'tag' | 'filename'>) {
  return `${MEDIA_URL}/${file.tag}/${file._id}/${encodeURIComponent(file.filename || 'original')}`
}

/** Reactions key custom emoji by their 26-character id; others are unicode. */
export function customEmojiUrl(reaction: string) {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(reaction) ? `${MEDIA_URL}/emojis/${reaction}` : null
}

/** 1536 → "1.5 KB", in the user's locale. */
export function formatFileSize(bytes: number, locale: string) {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toLocaleString(locale, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`
}
