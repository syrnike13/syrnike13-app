import {
  FLOATING_BAR_BOTTOM_CLASS,
  FLOATING_BAR_HEIGHT_CLASS,
} from '#/components/layout/shell-chrome'
import { cn } from '#/lib/utils'

/** Оверлей панели управления: тот же bottom-2, что у UserPanel. */
export const voiceStageControlsChromeClass = cn(
  'absolute inset-x-0 z-50 flex justify-center px-2',
  FLOATING_BAR_BOTTOM_CLASS,
) as const

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

/** Сетка плиток 16:9 под число слотов (участники + опционально invite). */
export function voiceStageGridClass(slotCount: number) {
  if (slotCount <= 0) return 'grid-cols-1'

  if (slotCount === 1) {
    return cn('grid-cols-1')
  }

  if (slotCount === 2) {
    return cn('grid-cols-1 sm:grid-cols-2')
  }

  if (slotCount <= 4) {
    return cn('grid-cols-1 sm:grid-cols-2')
  }

  if (slotCount <= 6) {
    return cn('grid-cols-2 md:grid-cols-3')
  }

  if (slotCount <= 9) {
    return cn('grid-cols-2 md:grid-cols-3 lg:grid-cols-3')
  }

  if (slotCount <= 12) {
    return cn('grid-cols-2 sm:grid-cols-3 lg:grid-cols-4')
  }

  return cn('grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-5')
}

export function shouldShowVoiceInviteSlot(participantCount: number) {
  return participantCount === 1
}
