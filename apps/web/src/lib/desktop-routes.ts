import { isAppPath } from './device-routing'

const DESKTOP_PUBLIC_PREFIXES = [
  '/desktop',
  '/invite',
  '/login',
  '/admin',
] as const

const DESKTOP_OVERLAY_PATH = '/desktop/overlay'

export const DESKTOP_ENTRY_PATH = '/'

/** Пути, доступные в desktop-сборке (приложение и его публичные входы). */
export function isDesktopAllowedPath(pathname: string) {
  if (isAppPath(pathname)) return true
  return DESKTOP_PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}

export function isDesktopOverlayPath(pathname: string) {
  return pathname === DESKTOP_OVERLAY_PATH
}
