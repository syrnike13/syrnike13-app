import { publicAppUrl } from './public-origin'

/** Публичная ссылка на сообщение в канале. */
export function messageDeepLink(channelId: string, messageId: string) {
  const path = `/app/c/${channelId}?m=${encodeURIComponent(messageId)}`
  return publicAppUrl(path)
}
