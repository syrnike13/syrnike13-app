import { useRouterState } from '@tanstack/react-router'

/**
 * Префикс URL активной зоны: `/m` на мобильных роутах, пустая строка на
 * десктопных. Используется shared-компонентами для построения ссылок.
 */
export function useAppRoutePrefix(): '' | '/m' {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  return pathname === '/m' || pathname.startsWith('/m/') ? '/m' : ''
}

/**
 * Префикс route id для `useMatch`/`useParams`: у десктопного приложения
 * pathless layout `/_app`, поэтому его id не совпадает с URL.
 */
export function useAppRouteIdPrefix(): '/_app' | '/m' {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  return pathname === '/m' || pathname.startsWith('/m/') ? '/m' : '/_app'
}

/**
 * Линейный вариант `useAppRoutePrefix` для мест, где нельзя вызвать хук
 * (например, в статических конфигах). Предпочитайте хук.
 */
export function appRoutePrefixForPath(pathname: string): '' | '/m' {
  return pathname === '/m' || pathname.startsWith('/m/') ? '/m' : ''
}
