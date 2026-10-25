import { useTranslations } from '@syrnike13/ui/i18n'

import { ChevronLeftIcon, ChevronRightIcon, MinusIcon, SquareIcon, XIcon } from '#/components/icons'

import {
  SHELL_TITLEBAR_WIN32_BUTTON_WIDTH_PX,
  SHELL_TITLEBAR_WIN32_NAV_INSET_PX,
  shellTitleBarNoDragClass,
} from '#/components/layout/shell-chrome'
import { useShellHistoryNav } from '#/features/navigation/use-shell-history-nav'
import { usePlatform } from '#/platform/use-platform'
import { config } from '#/lib/config'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'
import { Button } from '@syrnike13/ui/primitives/button'

const titleBarWindowButtonClass =
  'shell-title-bar-window-button inline-flex h-(--titlebar-height) w-(--titlebar-button-width) shrink-0 items-center justify-center border-0 bg-transparent p-0 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground'

type ShellHistoryNavButtonsProps = {
  layout?: 'default' | 'macos' | 'windows'
  heightPx?: number
}

export function ShellHistoryNavButtons({
  layout = 'default',
  heightPx,
}: ShellHistoryNavButtonsProps) {
  const t = useTranslations('layout.nav')
  const { canGoBack, canGoForward, goBack, goForward } = useShellHistoryNav()
  const isMac = layout === 'macos'
  const isWindows = layout === 'windows'
  const isFullHeight = isMac || isWindows
  const isNightly = config.releaseChannel === 'nightly'

  const navButtonClass = cn('text-muted-foreground', isFullHeight && 'h-full')

  return (
    <div
      className={cn(
        'flex shrink-0 items-center',
        isWindows && heightPx != null
          ? 'h-(--titlebar-nav-height) pl-(--titlebar-nav-inset)'
          : isFullHeight && 'h-full',
        isMac && 'gap-1 pr-1',
        isWindows && 'gap-0.5',
        !isFullHeight && 'h-full gap-0.5 px-1',
        shellTitleBarNoDragClass,
      )}
      style={
        isWindows && heightPx != null
          ? ({
              '--titlebar-nav-height': `${heightPx}px`,
              '--titlebar-nav-inset': `${SHELL_TITLEBAR_WIN32_NAV_INSET_PX}px`,
            } as CSSVars)
          : undefined
      }
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={navButtonClass}
        aria-label={t('back')}
        disabled={!canGoBack}
        onClick={goBack}
      >
        <ChevronLeftIcon />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={navButtonClass}
        aria-label={t('forward')}
        disabled={!canGoForward}
        onClick={goForward}
      >
        <ChevronRightIcon />
      </Button>
      {isNightly ? (
        <span className="ml-1 inline-flex h-5 shrink-0 items-center rounded border border-chart-2/40 bg-chart-2/10 px-1.5 text-xs font-medium leading-none text-chart-2">
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
  const t = useTranslations('layout.nav')
  const { desktop } = usePlatform()
  if (!desktop) return null

  return (
    <div
      className={cn(
        'shell-title-bar-window-controls flex h-(--titlebar-height) shrink-0',
        shellTitleBarNoDragClass,
      )}
      style={
        {
          '--titlebar-height': `${heightPx}px`,
          '--titlebar-button-width': `${SHELL_TITLEBAR_WIN32_BUTTON_WIDTH_PX}px`,
        } as CSSVars
      }
    >
      {/* eslint-disable-next-line design/no-lookalike -- native window caption button */}
      <button
        type="button"
        className={titleBarWindowButtonClass}
        aria-label={t('minimize')}
        onClick={() => desktop.window.minimize()}
      >
        <MinusIcon className="size-3.5" />
      </button>
      {/* eslint-disable-next-line design/no-lookalike -- native window caption button */}
      <button
        type="button"
        className={titleBarWindowButtonClass}
        aria-label={t('maximize')}
        onClick={() => desktop.window.maximize()}
      >
        <SquareIcon className="size-3" />
      </button>
      {/* eslint-disable-next-line design/no-lookalike -- native window caption button */}
      <button
        type="button"
        className={cn(
          titleBarWindowButtonClass,
          'hover:bg-destructive hover:text-destructive-foreground',
        )}
        aria-label={t('close')}
        onClick={() => desktop.window.close()}
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  )
}
