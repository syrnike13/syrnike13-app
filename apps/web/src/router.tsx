import '#/features/appearance/appearance-bootstrap'
import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

import { useTranslations } from '@syrnike13/ui/i18n'

import { GatewayLoadingScreen } from '#/components/layout/gateway-loading-screen'

import { getContext } from './integrations/tanstack-query/root-provider'
import { buttonVariants } from '@syrnike13/ui/primitives/button'
import { cn } from '#/lib/utils'

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
  const t = useTranslations('common.notFound')

  return (
    <div className="gradient-surface-content flex min-h-svh items-center justify-center bg-background px-6 text-foreground">
      <div className="flex max-w-md flex-col items-center text-center">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          404
        </p>
        <h1 className="mt-3 text-2xl font-semibold">{t('title')}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {t('description')}
        </p>
        <a
          href="/"
          className={cn(buttonVariants(), 'mt-5')}
        >
          {t('home')}
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
