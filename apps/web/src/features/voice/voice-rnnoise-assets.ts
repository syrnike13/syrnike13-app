const RNNOISE_VENDOR_COMMIT = '860d8053d4917389dfdebb20d88d0bb6ce950bda'
const RNNOISE_VENDOR_CDN =
  `https://cdn.jsdelivr.net/gh/dadadah/livekit-rnnoise-processor@${RNNOISE_VENDOR_COMMIT}/dist/`

/** Relative path to vendored RNNoise assets in `apps/web/public/rnnoise/`. */
export const RNNOISE_PUBLIC_PATH = 'rnnoise/'

function normalizeBaseUrl(url: string) {
  return url.endsWith('/') ? url : `${url}/`
}

function resolvePublicRnnoiseBaseUrl() {
  const path = `${import.meta.env.BASE_URL ?? '/'}${RNNOISE_PUBLIC_PATH}`.replace(
    /\/{2,}/g,
    '/',
  )

  if (typeof window === 'undefined') {
    return normalizeBaseUrl(path)
  }

  // DenoiseTrackProcessor passes this into `new URL(...)` — must be absolute.
  return normalizeBaseUrl(new URL(path, window.location.origin).href)
}

/** Absolute base URL for vendored RNNoise worklet + wasm (trailing slash). */
export function rnnoiseWorkletBaseUrl() {
  const fromEnv = import.meta.env.VITE_RNNOISE_WORKLET_CDN_URL?.trim()
  if (fromEnv) {
    return normalizeBaseUrl(fromEnv)
  }

  return resolvePublicRnnoiseBaseUrl()
}

export const rnnoiseVendorSource = {
  commit: RNNOISE_VENDOR_COMMIT,
  cdnBaseUrl: RNNOISE_VENDOR_CDN,
} as const
