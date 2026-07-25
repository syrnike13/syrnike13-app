import { useEffect, useRef, useState } from 'react'

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
    let cancelled = false
    const initialRevision = pushedStateRevision.current
    void desktop.media
      .getRuntimeState()
      .then((next) => {
        if (
          !cancelled &&
          pushedStateRevision.current === initialRevision
        ) {
          setState(next)
        }
      })
      .catch(() => undefined)
    const unsubscribe = desktop.media.onRuntimeState((next) => {
      if (cancelled) return
      pushedStateRevision.current += 1
      setState(next)
    })
    return () => {
      cancelled = true
      unsubscribe()
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
  const retry = async () => {
    if (retrying) return
    setRetrying(true)
    const retryRevision = pushedStateRevision.current
    try {
      const next = await desktop.media.retryRuntime()
      if (pushedStateRevision.current === retryRevision) setState(next)
    } catch {
      const next = await desktop.media.getRuntimeState().catch(() => null)
      if (
        next &&
        pushedStateRevision.current === retryRevision
      ) {
        setState(next)
      }
    } finally {
      setRetrying(false)
    }
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
          onClick={() => void retry()}
        >
          {retrying ? 'Перезапускаем…' : 'Перезапустить медиа'}
        </Button>
      ) : null}
    </div>
  )
}
