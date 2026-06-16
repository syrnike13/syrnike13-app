const DESKTOP_ROUTE_PREFIXES = ['/app', '/m', '/desktop', '/invite', '/login', '/admin'] as const
const DESKTOP_OVERLAY_PATH = '/desktop/overlay'

export const DESKTOP_ENTRY_PATH = '/app'

/** Пути, доступные в desktop-сборке (без лендинга и публичных web-only страниц). */
export function isDesktopAllowedPath(pathname: string) {
  return DESKTOP_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}

export function isDesktopOverlayPath(pathname: string) {
  return pathname === DESKTOP_OVERLAY_PATH
}
