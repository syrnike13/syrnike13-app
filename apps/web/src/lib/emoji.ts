import { config } from '#/lib/config'

/** ID кастомного emoji в формате API (`:01ABCDEF...:`). */
export const CUSTOM_EMOJI_ID_RE = /:([0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}):/g

export function customEmojiImageUrl(emojiId: string) {
  return `${config.mediaUrl}/emojis/${emojiId}`
}

export function isCustomEmojiId(value: string) {
  return /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/i.test(value)
}
