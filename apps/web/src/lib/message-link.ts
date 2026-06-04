/** Публичная ссылка на сообщение в канале. */
export function messageDeepLink(channelId: string, messageId: string) {
  const path = `/app/c/${channelId}?m=${encodeURIComponent(messageId)}`
  if (typeof window === 'undefined') {
    return path
  }
  return `${window.location.origin}${path}`
}
