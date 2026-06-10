import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { DesktopOverlayState } from '@syrnike13/platform'

import { DesktopOverlayHud } from '#/features/overlay/desktop-overlay-hud'
import { usePlatform } from '#/platform/use-platform'

export const Route = createFileRoute('/desktop/overlay')({
  component: DesktopOverlayRoute,
})

function DesktopOverlayRoute() {
  const { desktop } = usePlatform()
  const [state, setState] = useState<DesktopOverlayState | null>(null)

  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    return () => {
      document.documentElement.style.background = ''
      document.body.style.background = ''
    }
  }, [])

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    void desktop.overlay.getState().then((nextState) => {
      if (!cancelled) setState(nextState)
    })
    const unsubscribe = desktop.overlay.onStateChange((nextState) => {
      if (!cancelled) setState(nextState)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [desktop])

  return state ? <DesktopOverlayHud state={state} /> : null
}
