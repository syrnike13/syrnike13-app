import { useMemo, useSyncExternalStore } from 'react'

import {
  getPlatformCapabilities,
  getSyrnikeDesktop,
  getSyrnikeRuntime,
} from '#/platform/runtime'

function subscribeDesktopBridge(onStoreChange: () => void) {
  if (typeof window === 'undefined') return () => {}

  const interval = window.setInterval(() => {
    if (window.syrnikeDesktop) onStoreChange()
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
      capabilities: getPlatformCapabilities(),
      isDesktop: Boolean(desktop),
    }),
    [desktop],
  )
}
