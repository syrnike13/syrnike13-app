import type { ReactNode } from 'react'

import { CHANNEL_SIDEBAR_WIDTH_CLASS } from '#/components/layout/left-sidebar-stack'
import { ServerRail } from '#/components/layout/server-rail'
import {
  FLOATING_BAR_BOTTOM_CLASS,
  FLOATING_BAR_INSET_X_CLASS,
  shellDivider,
  shellNavSurface,
} from '#/components/layout/shell-chrome'
import { cn } from '#/lib/utils'

type ShellNavColumnProps = {
  sidebar: ReactNode
  overlay: ReactNode
  userPanelReservePx: number
}

/**
 * Левая колонка shell: рельс + навигация.
 * `overlay` (UserPanel) — absolute внизу колонки; ширина = ширине колонки (CSS).
 */
export function ShellNavColumn({
  sidebar,
  overlay,
  userPanelReservePx,
}: ShellNavColumnProps) {
  return (
    <div className="relative flex h-full min-h-0 shrink-0 flex-col">
      {/* Навигационная поверхность под рельсом и колонкой: без неё сквозь
          скругление `rounded-tl-shell` просвечивает самый нижний слой и в углу
          остаётся тёмный клин. */}
      <div className={cn('flex min-h-0 flex-1', shellNavSurface)}>
        <ServerRail
          variant="desktop"
          userPanelReservePx={userPanelReservePx}
        />
        <div
          className={cn(
            'flex min-h-0 flex-col overflow-hidden rounded-tl-shell border-l border-t shadow-sm',
            CHANNEL_SIDEBAR_WIDTH_CLASS,
            shellDivider,
            shellNavSurface,
          )}
        >
          {sidebar}
        </div>
      </div>
      <div
        className={cn(
          'pointer-events-none absolute z-50',
          FLOATING_BAR_INSET_X_CLASS,
          FLOATING_BAR_BOTTOM_CLASS,
        )}
      >
        <div className="pointer-events-auto w-full">{overlay}</div>
      </div>
    </div>
  )
}
