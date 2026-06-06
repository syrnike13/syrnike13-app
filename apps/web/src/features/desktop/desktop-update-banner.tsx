import { useEffect, useState } from 'react'

import { Button } from '#/components/ui/button'
import { useShellTitleBarHeightPx } from '#/components/layout/shell-title-bar'
import { usePlatform } from '#/platform/use-platform'
import type { DesktopUpdateState } from '@syrnike13/platform'

export function DesktopUpdateBanner() {
  const { desktop } = usePlatform()
  const titleBarHeightPx = useShellTitleBarHeightPx()
  const [state, setState] = useState<DesktopUpdateState | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!desktop) return
    let cancelled = false

    void desktop.updates.getState().then((value) => {
      if (!cancelled) setState(value)
    })

    const unsubscribe = desktop.updates.onStateChange((nextState) => {
      if (cancelled) return
      setState(nextState)
      if (nextState.status === 'ready') setDismissed(false)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [desktop])

  if (!desktop || !state || dismissed) return null

  if (state.status === 'downloading') {
    return (
      <div
        className="fixed inset-x-0 z-50 border-b border-border/60 bg-background/95 px-4 py-2 text-sm text-muted-foreground backdrop-blur"
        style={{ top: titleBarHeightPx }}
      >
        Загрузка обновления… {Math.round(state.percent)}%
      </div>
    )
  }

  if (state.status !== 'ready') return null

  return (
    <div
      className="fixed inset-x-0 z-50 flex flex-wrap items-center justify-between gap-3 border-b border-primary/30 bg-background/95 px-4 py-2.5 text-sm backdrop-blur"
      style={{ top: titleBarHeightPx }}
    >
      <span>
        Доступно обновление{' '}
        <span className="font-medium text-foreground">v{state.version}</span>.
        Перезапустите приложение, чтобы установить.
      </span>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => desktop.updates.install()}>
          Перезапустить
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
          Позже
        </Button>
      </div>
    </div>
  )
}
