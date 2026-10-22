import './styles.css'

import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { useTranslations } from '@syrnike13/ui/i18n'
import { DEFAULT_THEME_ID, applyThemeToDocument } from '@syrnike13/ui/tokens'
import { routeTree } from './routeTree.gen'

import { getContext } from './integrations/tanstack-query/root-provider'

if (typeof document !== 'undefined') {
  applyThemeToDocument({ themeId: DEFAULT_THEME_ID, colorMode: 'dark' }, true)
}

export function getRouter() {
  const context = getContext()

  return createTanStackRouter({
    routeTree,
    context,
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    defaultNotFoundComponent: DefaultNotFoundComponent,
  })
}

function DefaultNotFoundComponent() {
  const t = useTranslations('common')
  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-6 text-foreground">
      <div className="max-w-md text-center">
        <p className="text-xs font-semibold uppercase text-muted-foreground">
          404
        </p>
        <h1 className="mt-3 text-2xl font-semibold">{t('notFound')}</h1>
      </div>
    </div>
  )
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
