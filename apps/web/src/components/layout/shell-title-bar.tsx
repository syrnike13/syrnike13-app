import type { CSSProperties, ReactElement } from 'react'
import type { DesktopOs } from '@syrnike13/platform'

import {
  getShellTitleBarHeightPx,
  getShellTitleBarMacosNavTopPx,
  SHELL_TITLEBAR_MACOS_INSET_PX,
  SHELL_TITLEBAR_MACOS_NAV_BUTTON_PX,
  SHELL_TITLEBAR_WIN32_BUTTON_WIDTH_PX,
  shellLowestSurface,
  shellTitleBarDragClass,
} from '#/components/layout/shell-chrome'
import {
  ShellHistoryNavButtons,
  ShellWindowControls,
} from '#/components/layout/shell-title-bar-controls'
import { usePlatform } from '#/platform/use-platform'
import { cn } from '#/lib/utils'

function ShellTitleBarDragRegion({ className }: { className?: string }) {
  return <div className={cn('min-w-0 flex-1', shellTitleBarDragClass, className)} />
}

function MacShellTitleBar({ heightPx }: { heightPx: number }) {
  const navTopPx = getShellTitleBarMacosNavTopPx()

  return (
    <header
      className={cn('relative shrink-0 overflow-visible', shellLowestSurface)}
      style={{ height: heightPx }}
    >
      <ShellTitleBarDragRegion className="h-full w-full" />
      <div
        className="absolute z-10"
        style={{
          left: SHELL_TITLEBAR_MACOS_INSET_PX,
          top: navTopPx,
          height: SHELL_TITLEBAR_MACOS_NAV_BUTTON_PX,
        }}
      >
        <ShellHistoryNavButtons layout="macos" />
      </div>
    </header>
  )
}

function WindowsShellTitleBar({ heightPx }: { heightPx: number }) {
  const headerStyle = {
    height: heightPx,
    maxHeight: heightPx,
    minHeight: heightPx,
    '--shell-titlebar-height': `${heightPx}px`,
    '--shell-titlebar-button-width': `${SHELL_TITLEBAR_WIN32_BUTTON_WIDTH_PX}px`,
  } satisfies CSSProperties & {
    '--shell-titlebar-height': string
    '--shell-titlebar-button-width': string
  }

  return (
    <header
      className={cn(
        'shell-title-bar-windows relative shrink-0 overflow-hidden',
        shellLowestSurface,
      )}
      style={headerStyle}
    >
      <ShellTitleBarDragRegion className="absolute inset-0" />
      <div className="absolute inset-y-0 left-0 z-10">
        <ShellHistoryNavButtons layout="windows" heightPx={heightPx} />
      </div>
      <div className="absolute inset-y-0 right-0 z-10">
        <ShellWindowControls heightPx={heightPx} />
      </div>
    </header>
  )
}

function LinuxShellTitleBar({ heightPx }: { heightPx: number }) {
  return (
    <header
      className={cn('relative shrink-0 overflow-hidden', shellLowestSurface)}
      style={{ height: heightPx }}
    >
      <ShellTitleBarDragRegion className="absolute inset-0" />
      <div className="absolute inset-y-0 right-0 z-10">
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
        shellLowestSurface,
      )}
    >
      <ShellHistoryNavButtons />
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

export function useShellTitleBarHeightPx(): number {
  const { capabilities, desktop } = usePlatform()

  if (!capabilities.customWindowChrome || !desktop) return 0
  return getShellTitleBarHeightPx(desktop.platform.os)
}
