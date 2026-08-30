import { useEffect, useRef, useState } from 'react'
import { Effect, Fiber } from 'effect'

import type { NativeMediaRuntimeState } from '@syrnike13/platform'

import { TriangleAlertIcon } from '#/components/icons'
import { usePlatform } from '#/platform/use-platform'

export function NativeMediaRuntimeBanner() {
  const { desktop } = usePlatform()
  const [state, setState] = useState<NativeMediaRuntimeState | null>(null)
  const pushedStateRevision = useRef(0)

  useEffect(() => {
    if (!desktop) return
    const unsubscribe = desktop.media.onRuntimeState((next) => {
      pushedStateRevision.current += 1
      setState(next)
    })
    const initialRevision = pushedStateRevision.current
    const fiber = Effect.runFork(
      Effect.tryPromise({
        try: () => desktop.media.getRuntimeState(),
        catch: (cause) => cause,
      }).pipe(
        Effect.tap((next) =>
          Effect.sync(() => {
            if (pushedStateRevision.current === initialRevision) setState(next)
          }),
        ),
        Effect.ignore,
      ),
    )
    return () => {
      unsubscribe()
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [desktop])

  if (!desktop || !state) return null

  return (
    <div
      className="flex shrink-0 items-center justify-center gap-2 border-b border-destructive/20 bg-destructive/10 px-3 py-1.5 text-xs text-destructive-foreground"
      role="status"
      aria-live="polite"
    >
      <TriangleAlertIcon className="size-3.5" aria-hidden />
      <span>
        Нативные медиа временно недоступны, пока мы пересобираем движок.
      </span>
    </div>
  )
}
