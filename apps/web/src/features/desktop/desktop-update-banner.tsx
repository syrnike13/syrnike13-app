import { useEffect, useState } from 'react'

import { DownloadIcon } from '#/components/icons'
import { shellTitleBarNoDragClass } from '#/components/layout/shell-chrome'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { usePlatform } from '#/platform/use-platform'
import type { DesktopUpdateState } from '@syrnike13/platform'
import { cn } from '#/lib/utils'

/**
 * Компактная кнопка обновления для title bar (зелёная иконка + тултип).
 * Клик → install/restart.
 */
export function DesktopUpdateTitleBarButton({
  className,
}: {
  className?: string
}) {
  const { desktop } = usePlatform()
  const [state, setState] = useState<DesktopUpdateState | null>(null)

  useEffect(() => {
    if (!desktop) return
    let cancelled = false

    void desktop.updates.getState().then((value) => {
      if (!cancelled) setState(value)
    })

    const unsubscribe = desktop.updates.onStateChange((nextState) => {
      if (!cancelled) setState(nextState)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [desktop])

  if (!desktop || !state) return null
  if (state.status !== 'ready' && state.status !== 'downloading') return null

  const ready = state.status === 'ready'
  const tooltip = ready
    ? `Доступно обновление v${state.version}. Нажмите, чтобы перезапустить и установить.`
    : `Загрузка обновления… ${Math.round(state.percent)}%`

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={tooltip}
            disabled={!ready}
            className={cn(
              'inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors',
              'text-chart-3 hover:bg-chart-3/15 hover:text-chart-3',
              'disabled:pointer-events-none disabled:opacity-50',
              shellTitleBarNoDragClass,
              className,
            )}
            onClick={() => {
              if (ready) desktop.updates.install()
            }}
          >
            <DownloadIcon className="size-4" aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
