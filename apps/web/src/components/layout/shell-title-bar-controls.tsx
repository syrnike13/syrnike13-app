import { ChevronLeftIcon, ChevronRightIcon, MinusIcon, SquareIcon, XIcon } from '#/components/icons'

import {
  SHELL_TITLEBAR_WIN32_BUTTON_WIDTH_PX,
  SHELL_TITLEBAR_WIN32_NAV_INSET_PX,
  shellTitleBarNoDragClass,
} from '#/components/layout/shell-chrome'
import { useShellHistoryNav } from '#/features/navigation/use-shell-history-nav'
import { usePlatform } from '#/platform/use-platform'
import { config } from '#/lib/config'
import { cn } from '#/lib/utils'

const titleBarIconButtonClass =
  'inline-flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-35'

const titleBarIconButtonDefaultClass = cn(titleBarIconButtonClass, 'size-7')

const titleBarWindowButtonClass =
  'shell-title-bar-window-button inline-flex shrink-0 items-center justify-center border-0 bg-transparent p-0 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground'

type ShellHistoryNavButtonsProps = {
  layout?: 'default' | 'macos' | 'windows'
  heightPx?: number
}

export function ShellHistoryNavButtons({
  layout = 'default',
  heightPx,
}: ShellHistoryNavButtonsProps) {
  const { canGoBack, canGoForward, goBack, goForward } = useShellHistoryNav()
  const isMac = layout === 'macos'
  const isWindows = layout === 'windows'
  const isFullHeight = isMac || isWindows
  const isNightly = config.releaseChannel === 'nightly'

  const fullHeightButtonClass = cn(
    titleBarIconButtonClass,
    'h-full w-7 shrink-0',
  )

  return (
    <div
      className={cn(
        'flex shrink-0 items-center',
        isFullHeight && 'h-full',
        isMac && 'gap-1 pr-1',
        isWindows && 'gap-0.5',
        !isFullHeight && 'h-full gap-0.5 px-1',
        shellTitleBarNoDragClass,
      )}
      style={
        isWindows && heightPx != null
          ? { height: heightPx, paddingLeft: SHELL_TITLEBAR_WIN32_NAV_INSET_PX }
          : undefined
      }
    >
      <button
        type="button"
        className={isFullHeight ? fullHeightButtonClass : titleBarIconButtonDefaultClass}
        aria-label="Назад"
        disabled={!canGoBack}
        onClick={goBack}
      >
        <ChevronLeftIcon className="size-4" />
      </button>
      <button
        type="button"
        className={isFullHeight ? fullHeightButtonClass : titleBarIconButtonDefaultClass}
        aria-label="Вперёд"
        disabled={!canGoForward}
        onClick={goForward}
      >
        <ChevronRightIcon className="size-4" />
      </button>
      {isNightly ? (
        <span className="ml-1 inline-flex h-5 shrink-0 items-center rounded border border-chart-2/40 bg-chart-2/10 px-1.5 text-[10px] font-medium leading-none text-chart-2">
          nightly
        </span>
      ) : null}
    </div>
  )
}

type ShellWindowControlsProps = {
  heightPx: number
}

export function ShellWindowControls({ heightPx }: ShellWindowControlsProps) {
  const { desktop } = usePlatform()
  if (!desktop) return null

  const buttonStyle = {
    height: heightPx,
    width: SHELL_TITLEBAR_WIN32_BUTTON_WIDTH_PX,
  }

  return (
    <div
      className={cn(
        'shell-title-bar-window-controls flex shrink-0',
        shellTitleBarNoDragClass,
      )}
      style={{ height: heightPx }}
    >
      <button
        type="button"
        className={titleBarWindowButtonClass}
        style={buttonStyle}
        aria-label="Свернуть"
        onClick={() => desktop.window.minimize()}
      >
        <MinusIcon className="size-3.5" />
      </button>
      <button
        type="button"
        className={titleBarWindowButtonClass}
        style={buttonStyle}
        aria-label="Развернуть"
        onClick={() => desktop.window.maximize()}
      >
        <SquareIcon className="size-3" />
      </button>
      <button
        type="button"
        className={cn(
          titleBarWindowButtonClass,
          'hover:bg-destructive hover:text-destructive-foreground',
        )}
        style={buttonStyle}
        aria-label="Закрыть"
        onClick={() => desktop.window.close()}
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  )
}
