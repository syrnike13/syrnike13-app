export type FloatingCorner =
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'

const FLOATING_CORNERS: readonly FloatingCorner[] = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
]

export const MOBILE_VOICE_TILE_CORNER_STORAGE_KEY =
  'syrnike13.mobile.voiceTileCorner'

export const MOBILE_VOICE_FLOATING_TILE_SIZE_PX = 56

export function isFloatingCorner(value: string): value is FloatingCorner {
  return (FLOATING_CORNERS as readonly string[]).includes(value)
}

export function floatingCornerFromStorage(
  storageKey: string,
  fallback: FloatingCorner = 'top-right',
): FloatingCorner {
  if (typeof window === 'undefined') return fallback
  try {
    const stored = window.localStorage.getItem(storageKey)
    return stored && isFloatingCorner(stored) ? stored : fallback
  } catch {
    return fallback
  }
}

export function saveFloatingCorner(
  storageKey: string,
  corner: FloatingCorner,
): void {
  try {
    window.localStorage.setItem(storageKey, corner)
  } catch {
    // ignore quota / private mode
  }
}

export function nearestFloatingCorner(
  clientX: number,
  clientY: number,
  viewportWidth: number,
  viewportHeight: number,
): FloatingCorner {
  const left = clientX < viewportWidth / 2
  const top = clientY < viewportHeight / 2
  if (top) {
    return left ? 'top-left' : 'top-right'
  }
  return left ? 'bottom-left' : 'bottom-right'
}

export function floatingCornerPositionClass(corner: FloatingCorner): string {
  switch (corner) {
    case 'top-left':
      return 'top-[calc(0.5rem+env(safe-area-inset-top))] left-2'
    case 'top-right':
      return 'top-[calc(0.5rem+env(safe-area-inset-top))] right-2'
    case 'bottom-left':
      return 'bottom-[calc(4.5rem+env(safe-area-inset-bottom))] left-2'
    case 'bottom-right':
      return 'bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-2'
    default: {
      const _exhaustive: never = corner
      return _exhaustive
    }
  }
}
