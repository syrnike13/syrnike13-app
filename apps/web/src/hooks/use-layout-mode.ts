import { useMediaQuery } from '#/hooks/use-media-query'

/**
 * Режим layout.
 *
 * - `wide` — десктопная раскладка с рельсом, сайдбаром и контентом рядом.
 * - `compact` — мобильная раскладка: одна панель за раз + нижние табы.
 *
 * Граница переключения — `lg` (1024px), совпадает с Tailwind breakpoint,
 * который уже используется для скрытия member sidebar и search strip.
 */
export type LayoutMode = 'wide' | 'compact'

export const COMPACT_BREAKPOINT = '(max-width: 1023.98px)'

export function useLayoutMode(): LayoutMode {
  const isCompact = useMediaQuery(COMPACT_BREAKPOINT)
  return isCompact ? 'compact' : 'wide'
}

/** Хук-предикат для случаев, где нужен булев флаг. */
export function useIsCompact(): boolean {
  return useMediaQuery(COMPACT_BREAKPOINT)
}
