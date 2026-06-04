import { cn } from '#/lib/utils'

/** Сетка плиток 16:9 под число слотов (участники + опционально invite). */
export function voiceStageGridClass(slotCount: number) {
  if (slotCount <= 0) return 'grid-cols-1'

  if (slotCount === 1) {
    return cn('grid-cols-1 max-w-3xl')
  }

  if (slotCount === 2) {
    return cn('grid-cols-1 sm:grid-cols-2 max-w-5xl')
  }

  if (slotCount <= 4) {
    return cn('grid-cols-1 sm:grid-cols-2 max-w-6xl')
  }

  if (slotCount <= 6) {
    return cn('grid-cols-2 md:grid-cols-3 max-w-7xl')
  }

  if (slotCount <= 9) {
    return cn('grid-cols-2 md:grid-cols-3 lg:grid-cols-3 max-w-[90rem]')
  }

  if (slotCount <= 12) {
    return cn('grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 max-w-[100rem]')
  }

  return cn(
    'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-5',
    'max-w-[120rem]',
  )
}

export function shouldShowVoiceInviteSlot(participantCount: number) {
  return participantCount > 0 && participantCount <= 4
}
