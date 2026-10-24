/**
 * Activity Origins (ADR-0011): `https://{application}.activities.syrnike13.ru`,
 * the nightly `*.activities.beta.syrnike13.ru` and the local stand on
 * `http://{application}.activities.localhost:14707`.
 */
const ACTIVITY_ORIGIN_PATTERN =
  /^(?:https:\/\/[a-z0-9-]+\.activities\.(?:beta\.)?syrnike13\.ru|http:\/\/[a-z0-9-]+\.activities\.localhost:14707)$/

export function isActivityOriginUrl(url: string) {
  try {
    return ACTIVITY_ORIGIN_PATTERN.test(new URL(url).origin)
  } catch {
    return false
  }
}

type ResponseHeaders = Record<string, string | string[]>

/**
 * Activity documents keep the activity proxy's own CSP (`frame-ancestors`,
 * `connect-src`); they only need to be embeddable under the app's COEP.
 */
export function activityResponseHeaders(headers: ResponseHeaders): ResponseHeaders {
  const result: ResponseHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (
      lower === 'cross-origin-embedder-policy' ||
      lower === 'cross-origin-resource-policy'
    ) {
      continue
    }
    result[name] = value
  }
  result['Cross-Origin-Embedder-Policy'] = ['credentialless']
  result['Cross-Origin-Resource-Policy'] = ['cross-origin']
  return result
}
