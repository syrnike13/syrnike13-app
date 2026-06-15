import { useEffect, useState } from 'react'

import { useEasterMode } from '#/features/easter/easter-mode-store'

export const LOADING_EASTER_EGG_PREVIEW_MS = 1200

type LoadingEasterEggPreviewWindow = Window & {
  __syrnikeLoadingEasterEggPreviewStartedAt?: number
}

function loadingEasterEggPreviewRemainingMs(easterModeEnabled: boolean) {
  if (!easterModeEnabled) return 0
  if (typeof window === 'undefined') return 0

  const previewWindow = window as LoadingEasterEggPreviewWindow
  const now = window.performance.now()

  previewWindow.__syrnikeLoadingEasterEggPreviewStartedAt ??= now

  return Math.max(
    0,
    LOADING_EASTER_EGG_PREVIEW_MS -
      (now - previewWindow.__syrnikeLoadingEasterEggPreviewStartedAt),
  )
}

export function useLoadingEasterEggPreviewGate() {
  const easterModeEnabled = useEasterMode()
  const [ready, setReady] = useState(() =>
    loadingEasterEggPreviewRemainingMs(easterModeEnabled) === 0,
  )

  useEffect(() => {
    const remainingMs = loadingEasterEggPreviewRemainingMs(easterModeEnabled)
    if (remainingMs === 0) {
      setReady(true)
      return
    }

    setReady(false)
    const timeout = window.setTimeout(() => setReady(true), remainingMs)
    return () => window.clearTimeout(timeout)
  }, [easterModeEnabled])

  return ready
}
