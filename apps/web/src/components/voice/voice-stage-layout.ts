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

/** Обёртка: центрирует сетку по вертикали и горизонтали в области стейджа. */
export const voiceStageGridOuterClass =
  'mx-auto flex min-h-0 w-full max-w-[96rem] flex-1 items-center justify-center overflow-y-auto' as const

/** Сетка плиток: на sm+ — 2/3/4 колонки, неполный ряд — «пирамида». */
export function voiceStageGridContainerClass(slotCount: number) {
  if (slotCount <= 1) {
    return 'grid w-full max-w-5xl auto-rows-min grid-cols-1'
  }

  if (slotCount <= 4) {
    return 'grid w-full auto-rows-min grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3'
  }

  if (slotCount <= 6) {
    return cn(
      'grid w-full auto-rows-min grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3',
      'md:grid-cols-3',
    )
  }

  if (slotCount <= 9) {
    return cn(
      'grid w-full auto-rows-min grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3',
      'md:grid-cols-3',
    )
  }

  if (slotCount <= 12) {
    return cn(
      'grid w-full auto-rows-min grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3',
      'md:grid-cols-3 lg:grid-cols-4',
    )
  }

  return cn(
    'grid w-full auto-rows-min grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3',
    'md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5',
  )
}

/** Позиция слота: центрирование одиночной плитки в неполном ряду. */
export function voiceStageGridSlotClass(slotCount: number, index: number) {
  if (slotCount <= 1) {
    return 'w-full min-w-0 max-w-5xl'
  }

  const classes = ['min-w-0 w-full']

  const isLast = index === slotCount - 1

  if (slotCount % 2 === 1 && isLast) {
    classes.push(
      'sm:col-span-2 sm:justify-self-center sm:w-[calc(50%-0.25rem)] sm:max-w-[calc(50%-0.25rem)]',
    )
  }

  if (slotCount > 4) {
    const remainder = slotCount % 3
    if (remainder === 1 && isLast) {
      classes.push(
        'md:col-span-3 md:justify-self-center md:w-[calc(33.333%-0.34rem)] md:max-w-[calc(33.333%-0.34rem)]',
      )
    } else if (remainder === 2 && index === slotCount - 2) {
      classes.push('md:col-start-2')
    }
  }

  return cn(...classes)
}

export function shouldShowVoiceInviteSlot(participantCount: number) {
  return participantCount === 1
}
