import type { ReactNode } from 'react'

import { cn } from '#/lib/utils'

/** Высота плавающей панели аккаунта на mobile (+ отступ снизу). */
export const USER_PANEL_RESERVE_PX = 120

/** Колонка списка каналов: было w-60 (240px), w-72 — 288px. */
export const CHANNEL_SIDEBAR_WIDTH_CLASS = 'w-72' as const

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
