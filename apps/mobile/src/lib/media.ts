import type { File } from '@syrnike13/api-types'

import { MEDIA_URL } from '../config'

/** Autumn serves a resized preview of any uploaded image by tag and id. */
export function mediaUrl(file: Pick<File, '_id' | 'tag'> | null | undefined) {
  return file ? `${MEDIA_URL}/${file.tag}/${file._id}` : null
}
