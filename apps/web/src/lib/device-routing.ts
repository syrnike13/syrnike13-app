/** Phones get the React Native app's browser build, served beside this one. */
export const MOBILE_APP_PATH = '/m'

/** Top-level paths of the signed-in app (not public pages). */
export const APP_ROUTE_PREFIXES = [
  '/c',
  '/friends',
  '/settings',
  '/servers',
  '/feedback',
  '/voice-debug',
] as const

export function isAppPath(pathname: string): boolean {
  if (pathname === '/') return true
  return APP_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}

const MOBILE_UA_PATTERN =
  /Android|iPhone|iPod|iPad|Windows Phone|BlackBerry|Opera Mini|IEMobile|Mobile/i

/** Phones and tablets by User-Agent; a narrow desktop window stays desktop. */
export function isMobileUserAgent(userAgent?: string): boolean {
  const ua =
    userAgent ?? (typeof window === 'undefined' ? undefined : window.navigator?.userAgent)
  return ua ? MOBILE_UA_PATTERN.test(ua) : false
}

/**
 * Where a phone opening an app path goes in the mobile app: channels and
 * invites keep their id, everything else lands on its home. Other public
 * pages return null.
 */
export function mobileAppUrl(pathname: string): string | null {
  const invite = /^\/invite\/([^/]+)/.exec(pathname)
  if (invite) return `${MOBILE_APP_PATH}/invite/${invite[1]}`
  if (!isAppPath(pathname)) return null
  const channel = /^\/c\/([^/]+)/.exec(pathname)
  return channel
    ? `${MOBILE_APP_PATH}/channel/${channel[1]}`
    : `${MOBILE_APP_PATH}/`
}
