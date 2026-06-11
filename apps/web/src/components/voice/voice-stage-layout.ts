import {
  FLOATING_BAR_BOTTOM_CLASS,
  FLOATING_BAR_HEIGHT_CLASS,
} from '#/components/layout/shell-chrome'
import { cn } from '#/lib/utils'

/** Оверлей панели управления: тот же bottom-2, что у UserPanel. */
export const voiceStageControlsChromeClass = cn(
  'absolute inset-x-0 z-50 grid grid-cols-[1fr_auto_1fr] items-stretch gap-2 px-2',
  FLOATING_BAR_BOTTOM_CLASS,
) as const

/** Центральная колонка нижней полоски (группы контролов). */
export const voiceStageControlsChromeCenterClass =
  'flex items-stretch justify-center' as const

/** Правая колонка (fullscreen и т.п.). */
export const voiceStageControlsChromeTrailingClass =
  'flex items-stretch justify-end' as const

/** Отступ контента: bottom-2 (8px) + высота панели (56px) + зазор 8px. */
export const voiceStageContentBottomPadClass = 'pb-[72px]' as const

/**
 * Вертикальные отступы контента стейджа под оверлей шапки и панели управления.
 * На сами оверлеи не влияет.
 */
export const voiceStageContentInsetClass = cn(
  'pt-12 px-2 sm:px-3',
  voiceStageContentBottomPadClass,
) as const

export { FLOATING_BAR_HEIGHT_CLASS }

/** Отступы ленты: между плитками 8px, по краям 4px (2× ring-2). */
export const voiceStageFilmstripSpacingClass = 'gap-2 p-1' as const

/** Без верхнего padding — стык с основным тайлом через focusStackGap. */
export const voiceStageFilmstripTightTopClass = 'gap-2 px-1 pb-1 pt-0' as const

/** Зазор основной плитки и ленты: 8px (место под ring-2 сверху превью). */
export const voiceStageFocusStackGapClass = 'gap-2' as const

export function shouldShowVoiceInviteSlot(participantCount: number) {
  return participantCount === 1
}
