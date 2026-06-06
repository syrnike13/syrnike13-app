import { ChevronLeftIcon, ChevronRightIcon, MinusIcon, SquareIcon, XIcon } from 'lucide-react'

import {
  shellTitleBarNoDragClass,
} from '#/components/layout/shell-chrome'
import { useShellHistoryNav } from '#/features/navigation/use-shell-history-nav'
import { usePlatform } from '#/platform/use-platform'
import { cn } from '#/lib/utils'

const titleBarIconButtonClass =
  'inline-flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-35'

const titleBarIconButtonMacClass = cn(
  titleBarIconButtonClass,
  'h-full w-7 shrink-0',
)
const titleBarIconButtonDefaultClass = cn(titleBarIconButtonClass, 'size-7')

type ShellHistoryNavButtonsProps = {
  layout?: 'default' | 'macos'
}

export function ShellHistoryNavButtons({
  layout = 'default',
}: ShellHistoryNavButtonsProps) {
  const { canGoBack, canGoForward, goBack, goForward } = useShellHistoryNav()
  const isMac = layout === 'macos'

  return (
    <div
      className={cn(
        'flex h-full shrink-0 items-center',
        isMac ? 'gap-1 pr-1' : 'h-full gap-0.5 px-1',
        shellTitleBarNoDragClass,
      )}
    >
      <button
        type="button"
        className={isMac ? titleBarIconButtonMacClass : titleBarIconButtonDefaultClass}
        aria-label="Назад"
        disabled={!canGoBack}
        onClick={goBack}
      >
        <ChevronLeftIcon className="size-4" strokeWidth={2.5} />
      </button>
      <button
        type="button"
        className={isMac ? titleBarIconButtonMacClass : titleBarIconButtonDefaultClass}
        aria-label="Вперёд"
        disabled={!canGoForward}
        onClick={goForward}
      >
        <ChevronRightIcon className="size-4" strokeWidth={2.5} />
      </button>
    </div>
  )
}

export function ShellWindowControls() {
  const { desktop } = usePlatform()
  if (!desktop) return null

  return (
    <div
      className={cn('flex h-full shrink-0 items-stretch', shellTitleBarNoDragClass)}
    >
      <button
        type="button"
        className="inline-flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        aria-label="Свернуть"
        onClick={() => desktop.window.minimize()}
      >
        <MinusIcon className="size-3.5" />
      </button>
      <button
        type="button"
        className="inline-flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        aria-label="Развернуть"
        onClick={() => desktop.window.maximize()}
      >
        <SquareIcon className="size-3" />
      </button>
      <button
        type="button"
        className="inline-flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
        aria-label="Закрыть"
        onClick={() => desktop.window.close()}
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  )
}
