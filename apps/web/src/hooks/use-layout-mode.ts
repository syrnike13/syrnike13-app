import { useMediaQuery } from '#/hooks/use-media-query'

export const COMPACT_BREAKPOINT = '(max-width: 1023.98px)'

/** Хук-предикат для случаев, где нужен булев флаг. */
export function useIsCompact(): boolean {
  return useMediaQuery(COMPACT_BREAKPOINT)
}
