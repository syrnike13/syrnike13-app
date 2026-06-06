import { useMemo, useSyncExternalStore } from 'react'

import {
  getPlatformCapabilities,
  getSyrnikeDesktop,
  getSyrnikeRuntime,
} from '#/platform/runtime'

export function subscribeDesktopBridge(onStoreChange: () => void) {
  if (typeof window === 'undefined') return () => {}

  if (window.syrnikeDesktop) {
    queueMicrotask(onStoreChange)
    return () => {}
  }

  const interval = window.setInterval(() => {
    if (!window.syrnikeDesktop) return
    window.clearInterval(interval)
    onStoreChange()
  }, 50)

  return () => window.clearInterval(interval)
}

function getDesktopSnapshot() {
  return getSyrnikeDesktop()
}

function getDesktopServerSnapshot() {
  return null
}

/** Реактивный доступ к runtime и bridge (preload может подключиться чуть позже hydrate). */
export function usePlatform() {
  const desktop = useSyncExternalStore(
    subscribeDesktopBridge,
    getDesktopSnapshot,
    getDesktopServerSnapshot,
  )

  return useMemo(
    () => ({
      runtime: desktop ? ('desktop' as const) : getSyrnikeRuntime(),
      desktop,
      os: desktop?.platform.os ?? null,
      capabilities: getPlatformCapabilities(),
      isDesktop: Boolean(desktop),
    }),
    [desktop],
  )
}
