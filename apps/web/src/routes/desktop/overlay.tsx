import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Effect, Fiber } from 'effect'
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
    let unsubscribe = () => {}
    let pushedStateRevision = 0

    try {
      unsubscribe = desktop.overlay.onStateChange((nextState) => {
        pushedStateRevision += 1
        setState(nextState)
      })
    } catch (error) {
      console.error('[desktop-overlay] failed to subscribe to state', error)
    }

    const initialRevision = pushedStateRevision
    const fiber = Effect.runFork(
      Effect.tryPromise({
        try: () => desktop.overlay.getState(),
        catch: (cause) => cause,
      }).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.sync(() => {
              console.error('[desktop-overlay] failed to load state', error)
            }),
          onSuccess: (nextState) =>
            Effect.sync(() => {
              if (pushedStateRevision === initialRevision) setState(nextState)
            }),
        }),
      ),
    )

    return () => {
      unsubscribe()
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [desktop])

  return state ? <DesktopOverlayHud state={state} /> : null
}
