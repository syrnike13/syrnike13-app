import {
  DESKTOP_RELEASE_METADATA,
  type DesktopReleaseMetadata,
} from './desktop-app-identity'

const APP_ROUTE_PREFIXES = [
  '/c',
  '/friends',
  '/settings',
  '/servers',
  '/feedback',
  '/voice-debug',
] as const

function isAppRoute(pathname: string) {
  if (pathname === '/') return true
  return APP_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}

function safeRoute(pathname: string, search = '') {
  if (!pathname.startsWith('/')) return null
  if (pathname.includes('\\')) return null
  if (pathname.startsWith('/invite/')) return `${pathname}${search}`
  return isAppRoute(pathname) ? `${pathname}${search}` : null
}

export function routeFromDeepLinkForMetadata(
  rawUrl: string,
  metadata: DesktopReleaseMetadata,
) {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }

  if (url.protocol === `${metadata.protocolScheme}:`) {
    if (url.hostname === 'invite') {
      return safeRoute(`/invite${url.pathname}`, url.search)
    }
    if (url.hostname === 'app') {
      return safeRoute(url.pathname, url.search)
    }
    return null
  }

  if (url.protocol !== 'https:') return null
  if (url.hostname === metadata.appHost) {
    return safeRoute(url.pathname, url.search)
  }
  // Legacy-ссылки со старого общего домена: /invite/* и /app/*.
  if (url.hostname === metadata.publicHost) {
    if (url.pathname.startsWith('/invite/')) {
      return safeRoute(url.pathname, url.search)
    }
    if (url.pathname === '/app') return safeRoute('/', url.search)
    if (url.pathname.startsWith('/app/')) {
      return safeRoute(url.pathname.slice('/app'.length), url.search)
    }
  }
  return null
}

export function routeFromDeepLink(rawUrl: string) {
  return routeFromDeepLinkForMetadata(rawUrl, DESKTOP_RELEASE_METADATA)
}
