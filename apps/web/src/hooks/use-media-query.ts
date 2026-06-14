import { useEffect, useState } from 'react'

/**
 * Реактивно отслеживает media query.
 *
 * SSR- и jsdom-безопасно: если `window.matchMedia` недоступен (старые jsdom,
 * SSR), хук возвращает `false` и не падает. На клиенте с реальным `matchMedia`
 * синхронизируется после mount.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const mql = window.matchMedia(query)
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches)

    setMatches(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}
