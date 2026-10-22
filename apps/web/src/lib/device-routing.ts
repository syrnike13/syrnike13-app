import { COMPACT_BREAKPOINT } from '#/hooks/use-layout-mode'

export const MOBILE_ROUTE_PREFIX = '/m'

const MOBILE_ROUTE_PREFIXES = [MOBILE_ROUTE_PREFIX, '/admin'] as const

/** Верхнеуровневые пути десктопного приложения. */
export const APP_ROUTE_PREFIXES = [
  '/c',
  '/friends',
  '/settings',
  '/servers',
  '/feedback',
  '/voice-debug',
] as const

/** Пути мобильной зоны. Используется для защиты от зацикленного редиректа. */
export function isMobileAllowedPath(pathname: string): boolean {
  return MOBILE_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}

/** Является ли путь частью десктопного приложения (не публичной страницы). */
export function isAppPath(pathname: string): boolean {
  if (pathname === '/') return true
  return APP_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}

const MOBILE_UA_PATTERN =
  /Android|iPhone|iPod|iPad|Windows Phone|BlackBerry|Opera Mini|IEMobile|Mobile/i

/**
 * Распознаёт мобильный User-Agent.
 *
 * Если передан `userAgent` — используется он (для тестов и серверной стороны),
 * иначе берётся из `navigator.userAgent`. Безопасно для SSR (возвращает false).
 */
export function isMobileUserAgent(userAgent?: string): boolean {
  let ua: string | undefined
  if (userAgent !== undefined) {
    ua = userAgent
  } else if (typeof window !== 'undefined') {
    ua = window.navigator?.userAgent
  }
  if (!ua) return false
  return MOBILE_UA_PATTERN.test(ua)
}

/** Узкий экран по media query. Безопасно для SSR (возвращает false). */
export function isMobileViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return window.matchMedia(COMPACT_BREAKPOINT).matches
}

/**
 * Решает, показывать ли мобильную раскладку.
 *
 * Срабатывает при выполнении ЛЮБОГО из условий:
 *  - мобильный User-Agent (зашёл с телефона — всегда mobile);
 *  - узкий viewport (десктоп с узким окном тоже получит mobile).
 *
 * Это совпадает с запросом пользователя: и по UA, и по размеру экрана.
 */
export function shouldUseMobileLayout(): boolean {
  return isMobileUserAgent() || isMobileViewport()
}

/**
 * Переводит путь десктопного приложения в `/m/*` с сохранением path- и
 * search-параметров. Для публичных страниц возвращает null.
 *
 * Примеры:
 *   /                          → /m
 *   /?tab=online               → /m?tab=online
 *   /c/abc                     → /m/c/abc
 *   /c/abc?m=msg1              → /m/c/abc?m=msg1
 *   /servers/x/settings        → /m/servers/x/settings
 *   /friends                   → /m/friends
 *   /login                     → null
 */
export function mapAppPathToMobile(pathname: string): string | null {
  if (!isAppPath(pathname)) return null
  if (pathname === '/') return MOBILE_ROUTE_PREFIX
  return `${MOBILE_ROUTE_PREFIX}${pathname}`
}

/**
 * Переводит путь из `/m/*` обратно в путь десктопного приложения.
 *
 * Примеры:
 *   /m            → /
 *   /m/c/abc      → /c/abc
 *   /m/friends    → /friends
 *   /other        → null
 */
export function mapMobilePathToApp(pathname: string): string | null {
  if (pathname === MOBILE_ROUTE_PREFIX) return '/'
  if (pathname.startsWith(`${MOBILE_ROUTE_PREFIX}/`)) {
    return pathname.slice(MOBILE_ROUTE_PREFIX.length)
  }
  return null
}
