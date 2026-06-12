import '#/features/appearance/appearance-bootstrap'
import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

import { GatewayLoadingScreen } from '#/components/layout/gateway-loading-screen'

import { getContext } from './integrations/tanstack-query/root-provider'

export function getRouter() {
  const context = getContext()

  const router = createTanStackRouter({
    routeTree,
    context,
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    defaultPendingComponent: () => (
      <GatewayLoadingScreen gatewayState="idle" />
    ),
    defaultNotFoundComponent: DefaultNotFoundComponent,
  })

  return router
}

function DefaultNotFoundComponent() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-6 text-foreground">
      <div className="flex max-w-md flex-col items-center text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          404
        </p>
        <h1 className="mt-3 text-2xl font-semibold">Страница не найдена</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Такого маршрута в приложении нет.
        </p>
        <a
          href="/"
          className="mt-5 inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          На главную
        </a>
      </div>
    </div>
  )
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
