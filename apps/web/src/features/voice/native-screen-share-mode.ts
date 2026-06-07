import { shouldUseDesktopMediaEngine } from '#/features/voice/desktop-media-engine'

/** @deprecated Use shouldUseDesktopMediaEngine */
export function shouldUseMediaEngineScreenShare() {
  return shouldUseDesktopMediaEngine()
}

export { shouldUseDesktopMediaEngine }
