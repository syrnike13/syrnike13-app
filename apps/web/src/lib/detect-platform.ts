import type { DesktopPlatform } from '#/lib/config'

interface UserAgentDataLike {
  platform?: string
}

/**
 * Определяет десктоп-платформу по данным браузера.
 * Возвращает `null`, если запущено вне браузера (SSR) или платформу не удалось распознать.
 */
export function detectDesktopPlatform(): DesktopPlatform | null {
  if (typeof navigator === 'undefined') return null

  const uaData = (navigator as Navigator & { userAgentData?: UserAgentDataLike })
    .userAgentData
  const source = `${uaData?.platform ?? ''} ${navigator.platform ?? ''} ${
    navigator.userAgent ?? ''
  }`.toLowerCase()

  if (source.includes('win')) return 'windows'
  if (source.includes('mac') || source.includes('darwin')) return 'macos'
  if (source.includes('linux') || source.includes('x11')) return 'linux'

  return null
}
