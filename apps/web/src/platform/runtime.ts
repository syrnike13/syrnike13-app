import {
  getCapabilities,
  type PlatformCapabilities,
  type SyrnikeDesktopApi,
  type SyrnikeRuntime,
} from '@syrnike13/platform'

export function getSyrnikeDesktop(): SyrnikeDesktopApi | null {
  if (typeof window === 'undefined') return null
  return window.syrnikeDesktop ?? null
}

export function getSyrnikeRuntime(): SyrnikeRuntime {
  return getSyrnikeDesktop() ? 'desktop' : 'web'
}

export function getPlatformCapabilities(): PlatformCapabilities {
  return getCapabilities(getSyrnikeRuntime(), getSyrnikeDesktop()?.platform.os ?? null)
}

export function isDesktopRuntime() {
  return getSyrnikeRuntime() === 'desktop'
}
