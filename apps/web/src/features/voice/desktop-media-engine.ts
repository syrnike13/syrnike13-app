import { getPlatformCapabilities, getSyrnikeDesktop } from '#/platform/runtime'

/** Windows desktop: нативный media engine вместо browser media APIs. */
export function shouldUseDesktopMediaEngine() {
  return (
    getPlatformCapabilities().nativeMediaEngine && getSyrnikeDesktop() != null
  )
}
