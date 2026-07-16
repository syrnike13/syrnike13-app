import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'

import { Toaster } from '#/components/ui/sonner'
import { AuthProvider } from '#/features/auth/auth-context'
import TanstackQueryProvider from '#/integrations/tanstack-query/root-provider'
import { config } from '#/lib/config'

import type { QueryClient } from '@tanstack/react-query'

interface RouterContext {
  queryClient: QueryClient
}

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' https: data: blob:",
  "connect-src 'self' http://localhost:* http://127.0.0.1:* https:",
  "worker-src 'self' blob:",
].join('; ')

export const Route = createRootRouteWithContext<RouterContext>()({
  ssr: false,
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1, viewport-fit=cover',
      },
      { title: config.appTitle },
      { name: 'description', content: 'Админка syrnike13' },
    ],
  }),
  component: RootComponent,
  shellComponent: RootDocument,
})

function RootComponent() {
  const { queryClient } = Route.useRouteContext()

  return (
    <TanstackQueryProvider client={queryClient}>
      <AuthProvider>
        <Outlet />
        <Toaster richColors closeButton />
      </AuthProvider>
    </TanstackQueryProvider>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className="dark">
      <head>
        <meta httpEquiv="Content-Security-Policy" content={contentSecurityPolicy} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
