import type { ReactNode } from 'react'

import {
  FLOATING_BAR_HEIGHT_PX,
  floatingBarReservePx,
} from '#/components/layout/shell-chrome'
import { cn } from '#/lib/utils'

/** Fallback до первого измерения UserPanel (базовая строка + bottom-2). */
export const USER_PANEL_RESERVE_PX = floatingBarReservePx(FLOATING_BAR_HEIGHT_PX)

/** Колонка списка каналов: было w-60 (240px), w-72 — 288px. */
export const CHANNEL_SIDEBAR_WIDTH_CLASS = 'w-82' as const

type LeftSidebarStackProps = {
  children: ReactNode
}

export function LeftSidebarStack({ children }: LeftSidebarStackProps) {
  return (
    <div
      className={cn(
        'flex h-full min-h-0 shrink-0 flex-col',
        CHANNEL_SIDEBAR_WIDTH_CLASS,
      )}
    >
      {children}
    </div>
  )
}
