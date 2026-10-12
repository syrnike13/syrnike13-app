import {
  FLOATING_BAR_HEIGHT_PX,
  floatingBarReservePx,
} from '#/components/layout/shell-chrome'

/** Fallback до первого измерения UserPanel (базовая строка + bottom-2). */
export const USER_PANEL_RESERVE_PX = floatingBarReservePx(FLOATING_BAR_HEIGHT_PX)

/** Колонка списка каналов: было w-60 (240px), w-72 — 288px. */
export const CHANNEL_SIDEBAR_WIDTH_CLASS = 'w-82' as const
