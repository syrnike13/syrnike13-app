import { useEffect, useRef, useState } from 'react'
import { Effect, Fiber } from 'effect'

import type { NativeMediaRuntimeState } from '@syrnike13/platform'

import { Loader2Icon, TriangleAlertIcon } from '#/components/icons'
import { Button } from '#/components/ui/button'
import { usePlatform } from '#/platform/use-platform'

export function NativeMediaRuntimeBanner() {
  const { desktop } = usePlatform()
  const [state, setState] = useState<NativeMediaRuntimeState | null>(null)
  const [retrying, setRetrying] = useState(false)
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
            if (pushedStateRevision.current === initialRevision) {
              setState(next)
            }
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

  if (
    !desktop ||
    !state?.available ||
    (state.status !== 'degraded' && state.status !== 'recovering')
  ) {
    return null
  }

  const recovering = state.status === 'recovering'
  const retry = () => {
    if (retrying) return
    setRetrying(true)
    const retryRevision = pushedStateRevision.current
    Effect.runFork(
      Effect.tryPromise({
        try: () => desktop.media.retryRuntime(),
        catch: (cause) => cause,
      }).pipe(
        Effect.matchEffect({
          onFailure: () =>
            Effect.tryPromise({
              try: () => desktop.media.getRuntimeState(),
              catch: (cause) => cause,
            }).pipe(
              Effect.catch(() => Effect.succeed(null)),
              Effect.tap((next) =>
                Effect.sync(() => {
                  if (
                    next &&
                    pushedStateRevision.current === retryRevision
                  ) {
                    setState(next)
                  }
                }),
              ),
            ),
          onSuccess: (next) =>
            Effect.sync(() => {
              if (pushedStateRevision.current === retryRevision) {
                setState(next)
              }
            }),
        }),
        Effect.ensuring(
          Effect.sync(() => {
            setRetrying(false)
          }),
        ),
      ),
    )
  }

  return (
    <div
      className={
        recovering
          ? 'flex shrink-0 items-center justify-center gap-2 border-b border-chart-2/20 bg-chart-2/10 px-3 py-1.5 text-xs text-chart-2'
          : 'flex shrink-0 items-center justify-center gap-2 border-b border-destructive/20 bg-destructive/10 px-3 py-1.5 text-xs text-destructive-foreground'
      }
      role="status"
      aria-live="polite"
    >
      {recovering ? (
        <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
      ) : (
        <TriangleAlertIcon className="size-3.5" aria-hidden />
      )}
      <span>
        {recovering
          ? 'Восстанавливаем микрофон, камеру и демонстрацию экрана…'
          : 'Микрофон, камера и демонстрация экрана временно недоступны.'}
      </span>
      {!recovering ? (
        <Button
          size="sm"
          variant="outline"
          className="h-6 border-destructive/30 bg-background/50 px-2 text-xs text-foreground hover:bg-accent"
          disabled={retrying}
          onClick={retry}
        >
          {retrying ? 'Перезапускаем…' : 'Перезапустить медиа'}
        </Button>
      ) : null}
    </div>
  )
}
