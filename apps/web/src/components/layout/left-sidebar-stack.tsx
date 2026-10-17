import {
  FLOATING_BAR_HEIGHT_PX,
  floatingBarReservePx,
} from '#/components/layout/shell-chrome'

/** Fallback до первого измерения UserPanel (базовая строка + bottom-2). */
export const USER_PANEL_RESERVE_PX = floatingBarReservePx(FLOATING_BAR_HEIGHT_PX)

/** Колонка списка каналов: Discord 303px; 304px даёт ровный контент 1280px. */
export const CHANNEL_SIDEBAR_WIDTH_CLASS = 'w-76' as const
