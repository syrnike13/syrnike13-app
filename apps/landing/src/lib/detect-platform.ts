import type { DesktopPlatform } from '#/lib/config'

/**
 * Определяет десктоп-платформу по данным браузера.
 * Возвращает `null`, если платформу не удалось распознать.
 */
export function detectDesktopPlatform(): DesktopPlatform | null {
  if (typeof navigator === 'undefined') return null

  const userAgentData = Reflect.get(navigator, 'userAgentData') as
    | { platform?: string }
    | undefined
  const source = `${userAgentData?.platform ?? ''} ${navigator.platform ?? ''} ${
    navigator.userAgent ?? ''
  }`.toLowerCase()

  if (source.includes('win')) return 'windows'
  if (source.includes('mac') || source.includes('darwin')) return 'macos'
  if (source.includes('linux') || source.includes('x11')) return 'linux'

  return null
}
