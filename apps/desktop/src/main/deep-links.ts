import {
  DESKTOP_RELEASE_METADATA,
  type DesktopReleaseMetadata,
} from './desktop-app-identity'

function safeRoute(pathname: string, search = '') {
  if (!pathname.startsWith('/')) return null
  if (pathname.includes('\\')) return null
  if (pathname.startsWith('/invite/') || pathname.startsWith('/app/')) {
    return `${pathname}${search}`
  }
  return null
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
      return safeRoute(`/app${url.pathname}`, url.search)
    }
    return null
  }

  if (url.protocol !== 'https:' || url.hostname !== metadata.publicHost) return null
  return safeRoute(url.pathname, url.search)
}

export function routeFromDeepLink(rawUrl: string) {
  return routeFromDeepLinkForMetadata(rawUrl, DESKTOP_RELEASE_METADATA)
}
