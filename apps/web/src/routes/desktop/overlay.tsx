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
    document.documentElement.style.overflow = 'hidden'
    document.body.style.background = 'transparent'
    document.body.style.overflow = 'hidden'
    return () => {
      document.documentElement.style.background = ''
      document.documentElement.style.overflow = ''
      document.body.style.background = ''
      document.body.style.overflow = ''
    }
  }, [])

  useEffect(() => {
    if (!desktop) return
    let cancelled = false
    let unsubscribe = () => {}

    void desktop.overlay
      .getState()
      .then((nextState) => {
        if (!cancelled) setState(nextState)
      })
      .catch((error) => {
        console.error('[desktop-overlay] failed to load state', error)
      })

    try {
      unsubscribe = desktop.overlay.onStateChange((nextState) => {
        if (!cancelled) setState(nextState)
      })
    } catch (error) {
      console.error('[desktop-overlay] failed to subscribe to state', error)
    }

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [desktop])

  return state ? <DesktopOverlayHud state={state} /> : null
}
