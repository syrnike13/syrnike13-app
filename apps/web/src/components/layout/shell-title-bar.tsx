import type { ReactElement } from 'react'
import type { DesktopOs } from '@syrnike13/platform'

import {
  getShellTitleBarHeightPx,
  getShellTitleBarMacosNavTopPx,
  SHELL_TITLEBAR_MACOS_INSET_PX,
  SHELL_TITLEBAR_MACOS_NAV_BUTTON_PX,
  SHELL_TITLEBAR_WIN32_BUTTON_WIDTH_PX,
  shellNavSurface,
  shellTitleBarDragClass,
  shellTitleBarNoDragClass,
} from '#/components/layout/shell-chrome'
import {
  ShellHistoryNavButtons,
  ShellWindowControls,
} from '#/components/layout/shell-title-bar-controls'
import { DesktopUpdateTitleBarButton } from '#/features/desktop/desktop-update-banner'
import { usePlatform } from '#/platform/use-platform'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'

function ShellTitleBarDragRegion({ className }: { className?: string }) {
  return <div className={cn('min-w-0 flex-1', shellTitleBarDragClass, className)} />
}

function MacShellTitleBar({ heightPx }: { heightPx: number }) {
  const navTopPx = getShellTitleBarMacosNavTopPx()

  return (
    <header
      className={cn(
        'relative h-(--shell-titlebar-height) shrink-0 overflow-visible',
        shellNavSurface,
      )}
      style={{ '--shell-titlebar-height': `${heightPx}px` } as CSSVars}
    >
      <ShellTitleBarDragRegion className="h-full w-full" />
      <div
        className="absolute left-(--mac-nav-inset) top-(--mac-nav-top) h-(--mac-nav-size) z-10"
        style={
          {
            '--mac-nav-inset': `${SHELL_TITLEBAR_MACOS_INSET_PX}px`,
            '--mac-nav-top': `${navTopPx}px`,
            '--mac-nav-size': `${SHELL_TITLEBAR_MACOS_NAV_BUTTON_PX}px`,
          } as CSSVars
        }
      >
        <ShellHistoryNavButtons layout="macos" />
      </div>
      <div
        className={cn(
          'absolute inset-y-0 right-2 z-10 flex items-center',
          shellTitleBarNoDragClass,
        )}
      >
        <DesktopUpdateTitleBarButton />
      </div>
    </header>
  )
}

function WindowsShellTitleBar({ heightPx }: { heightPx: number }) {
  const headerStyle = {
    '--shell-titlebar-height': `${heightPx}px`,
    '--shell-titlebar-button-width': `${SHELL_TITLEBAR_WIN32_BUTTON_WIDTH_PX}px`,
  } as CSSVars

  return (
    <header
      className={cn(
        'shell-title-bar-windows relative h-(--shell-titlebar-height) max-h-(--shell-titlebar-height) min-h-(--shell-titlebar-height) shrink-0 overflow-hidden',
        shellNavSurface,
      )}
      style={headerStyle}
    >
      <ShellTitleBarDragRegion className="absolute inset-0" />
      <div className="absolute inset-y-0 left-0 z-10">
        <ShellHistoryNavButtons layout="windows" heightPx={heightPx} />
      </div>
      <div className="absolute inset-y-0 right-0 z-10 flex items-center">
        <div
          className={cn('flex items-center px-1', shellTitleBarNoDragClass)}
        >
          <DesktopUpdateTitleBarButton />
        </div>
        <ShellWindowControls heightPx={heightPx} />
      </div>
    </header>
  )
}

function LinuxShellTitleBar({ heightPx }: { heightPx: number }) {
  return (
    <header
      className={cn(
        'relative h-(--shell-titlebar-height) shrink-0 overflow-hidden',
        shellNavSurface,
      )}
      style={{ '--shell-titlebar-height': `${heightPx}px` } as CSSVars}
    >
      <ShellTitleBarDragRegion className="absolute inset-0" />
      <div className="absolute inset-y-0 right-0 z-10 flex items-center">
        <div
          className={cn('flex items-center px-1', shellTitleBarNoDragClass)}
        >
          <DesktopUpdateTitleBarButton />
        </div>
        <ShellWindowControls heightPx={heightPx} />
      </div>
    </header>
  )
}

function WebShellTitleBar() {
  return (
    <header
      className={cn(
        'relative flex h-9 shrink-0 items-center px-2',
        shellNavSurface,
      )}
    >
      <ShellHistoryNavButtons />
      <div
        className={cn(
          'ml-auto flex items-center',
          shellTitleBarNoDragClass,
        )}
      >
        <DesktopUpdateTitleBarButton />
      </div>
    </header>
  )
}

const titleBarByOs: Record<
  DesktopOs,
  (props: { heightPx: number }) => ReactElement
> = {
  darwin: MacShellTitleBar,
  win32: WindowsShellTitleBar,
  linux: LinuxShellTitleBar,
}

export function ShellTitleBar() {
  const { capabilities, desktop } = usePlatform()

  if (!desktop) return <WebShellTitleBar />
  if (!capabilities.customWindowChrome) return null

  const os = desktop.platform.os
  const heightPx = getShellTitleBarHeightPx(os)
  const TitleBar = titleBarByOs[os]

  return <TitleBar heightPx={heightPx} />
}
