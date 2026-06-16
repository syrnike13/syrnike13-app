const EXTERNAL_OPEN_PROTOCOLS = new Set([
  'http:',
  'https:',
  'spotify:',
  'yandexmusic:',
])

export function shouldOpenExternalUrl(url: string) {
  try {
    return EXTERNAL_OPEN_PROTOCOLS.has(new URL(url).protocol)
  } catch {
    return false
  }
}
