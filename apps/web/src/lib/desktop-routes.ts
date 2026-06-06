const DESKTOP_ROUTE_PREFIXES = ['/app', '/login'] as const

export const DESKTOP_ENTRY_PATH = '/app'

/** Пути, доступные в desktop-сборке (без лендинга и публичных web-only страниц). */
export function isDesktopAllowedPath(pathname: string) {
  return DESKTOP_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}
