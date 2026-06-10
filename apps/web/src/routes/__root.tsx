import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
  redirect,
  useRouterState,
} from '@tanstack/react-router'

import { NativeScrollbarEnhancer } from '#/components/native-scrollbar-enhancer'
import { ThemeProvider } from '#/components/theme-provider'
import { Toaster } from '#/components/ui/sonner'
import { AuthProvider } from '#/features/auth/auth-context'
import { SyncProvider } from '#/features/sync/sync-provider'
import TanstackQueryProvider from '#/integrations/tanstack-query/root-provider'

import appCss from '../styles.css?url'

import {
  DESKTOP_ENTRY_PATH,
  isDesktopAllowedPath,
  isDesktopOverlayPath,
} from '#/lib/desktop-routes'
import { isDesktopRuntime } from '#/platform/runtime'

import type { QueryClient } from '@tanstack/react-query'

interface MyRouterContext {
  queryClient: QueryClient
}

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://js.hcaptcha.com https://*.hcaptcha.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' https: data: blob:",
  "media-src 'self' https: data: blob:",
  "connect-src 'self' http://localhost:* http://127.0.0.1:* https: ws: wss:",
  "frame-src 'self' https://*.hcaptcha.com",
  "worker-src 'self' blob:",
].join('; ')

export const Route = createRootRouteWithContext<MyRouterContext>()({
  ssr: false,
  beforeLoad: ({ location }) => {
    if (typeof window === 'undefined') return
    if (!isDesktopRuntime()) return
    if (isDesktopAllowedPath(location.pathname)) return
    throw redirect({ to: DESKTOP_ENTRY_PATH, replace: true })
  },
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'syrnike13',
      },
      {
        name: 'description',
        content: 'Мессенджер syrnike13',
      },
      {
        name: 'theme-color',
        content: '#4a3f8f',
      },
      {
        name: 'apple-mobile-web-app-capable',
        content: 'yes',
      },
      {
        name: 'apple-mobile-web-app-title',
        content: 'syrnike13',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
      {
        rel: 'manifest',
        href: '/manifest.json',
      },
      {
        rel: 'apple-touch-icon',
        href: '/logo192.png',
      },
    ],
  }),
  component: RootComponent,
  shellComponent: RootDocument,
})

function RootComponent() {
  const { queryClient } = Route.useRouteContext()
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  if (isDesktopOverlayPath(pathname)) {
    return (
      <ThemeProvider>
        <NativeScrollbarEnhancer />
        <Outlet />
      </ThemeProvider>
    )
  }

  return (
    <TanstackQueryProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <SyncProvider>
            <NativeScrollbarEnhancer />
            <Outlet />
            <Toaster richColors closeButton />
          </SyncProvider>
        </AuthProvider>
      </ThemeProvider>
    </TanstackQueryProvider>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" suppressHydrationWarning>
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
