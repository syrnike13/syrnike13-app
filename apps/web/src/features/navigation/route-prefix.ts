import { useRouterState } from '@tanstack/react-router'

/**
 * Префикс активной зоны: `/m` на мобильных роутах, `/app` на десктопных.
 *
 * Используется в shared-компонентах (home, dm list, voice dock), которые
 * показываются и в `/app`, и в `/m`, но должны строить ссылки в рамках
 * текущей зоны — иначе пользователь на `/m` по клику улетит на `/app` и
 * попадёт обратно на `/m` через редирект (двойная навигация + flash).
 */
export function useAppRoutePrefix(): '/app' | '/m' {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  return pathname.startsWith('/m') ? '/m' : '/app'
}

/**
 * Линейный вариант `useAppRoutePrefix` для мест, где нельзя вызвать хук
 * (например, в статических конфигах). Предпочтайте хук.
 */
export function appRoutePrefixForPath(pathname: string): '/app' | '/m' {
  return pathname.startsWith('/m') ? '/m' : '/app'
}
