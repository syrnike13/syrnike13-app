import { fetchApiRoot } from '#/lib/api/client'

import type { ScreenShareCaptureLimits } from './voice-capture'

const FALLBACK_SCREEN_SHARE_LIMITS: ScreenShareCaptureLimits = {
  maxWidth: 1920,
  maxHeight: 1080,
  maxPixels: 1920 * 1080,
  maxBitrate: 8_000_000,
}

let cachedLimits: ScreenShareCaptureLimits | null = null
let loadPromise: Promise<ScreenShareCaptureLimits> | null = null

function finitePositiveNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined
}

function limitsFromScreenShareConfig(
  screenShareResolution: number[] | undefined,
  screenShareBitrate: unknown,
): ScreenShareCaptureLimits | null {
  const width = finitePositiveNumber(screenShareResolution?.[0])
  const height = finitePositiveNumber(screenShareResolution?.[1])
  const bitrate = finitePositiveNumber(screenShareBitrate)
  if (width == null && height == null && bitrate == null) return null

  return {
    maxWidth: width,
    maxHeight: height,
    maxPixels: width != null && height != null ? width * height : undefined,
    maxBitrate: bitrate,
  }
}

function tighterLimits(
  left: ScreenShareCaptureLimits | null,
  right: ScreenShareCaptureLimits | null,
) {
  if (!left) return right
  if (!right) return left

  const maxBitrate = Math.min(
    left.maxBitrate ?? Infinity,
    right.maxBitrate ?? Infinity,
  )
  const maxWidth = Math.min(left.maxWidth ?? Infinity, right.maxWidth ?? Infinity)
  const maxHeight = Math.min(
    left.maxHeight ?? Infinity,
    right.maxHeight ?? Infinity,
  )
  const maxPixels = Math.min(
    left.maxPixels ?? Infinity,
    right.maxPixels ?? Infinity,
  )

  return {
    maxWidth: Number.isFinite(maxWidth) ? maxWidth : undefined,
    maxHeight: Number.isFinite(maxHeight) ? maxHeight : undefined,
    maxPixels: Number.isFinite(maxPixels) ? maxPixels : undefined,
    maxBitrate: Number.isFinite(maxBitrate) ? maxBitrate : undefined,
  }
}

export async function resolveScreenShareCaptureLimits() {
  if (cachedLimits) return cachedLimits
  if (!loadPromise) {
    loadPromise = fetchApiRoot()
      .then((root) => {
        const limits = tighterLimits(
          limitsFromScreenShareConfig(
            root.features.limits.new_user.screen_share_resolution,
            root.features.limits.new_user.screen_share_bitrate,
          ),
          limitsFromScreenShareConfig(
            root.features.limits.default.screen_share_resolution,
            root.features.limits.default.screen_share_bitrate,
          ),
        )
        cachedLimits = limits ?? FALLBACK_SCREEN_SHARE_LIMITS
        return cachedLimits
      })
      .catch(() => {
        cachedLimits = FALLBACK_SCREEN_SHARE_LIMITS
        return cachedLimits
      })
  }

  return loadPromise
}
