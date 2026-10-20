import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
  redirect,
  useRouterState,
} from '@tanstack/react-router'

import { NativeScrollbarEnhancer } from '#/components/native-scrollbar-enhancer'
import { ThemeColorMeta } from '#/components/appearance/theme-color-meta'
import { APPEARANCE_BOOTSTRAP_SCRIPT } from '#/features/appearance/appearance-bootstrap'
import { PrismTuningOverlay } from '#/features/dev-tools/prism-tuning-overlay'
import { getDefaultThemeCss } from '@syrnike13/ui/tokens'
import { AppearanceProvider } from '#/features/appearance/appearance-context'
import { Toaster } from '#/components/ui/sonner'
import { SquircleNoScript } from '@syrnike13/ui/primitives/squircle'
import { AuthProvider } from '#/features/auth/auth-context'
import { SyncProvider } from '#/features/sync/sync-provider'
import TanstackQueryProvider from '#/integrations/tanstack-query/root-provider'
import { DesktopStartupUpdateGate } from '#/features/desktop/desktop-startup-update-gate'
import { DiagnosticErrorReporter } from '#/features/diagnostics/diagnostic-error-reporter'
import { AppLocaleProvider } from '#/features/i18n/locale-provider'

import appCss from '../styles.css?url'

import {
  DESKTOP_ENTRY_PATH,
  isDesktopAllowedPath,
  isDesktopOverlayPath,
} from '#/lib/desktop-routes'
import {
  isMobileAllowedPath,
  mapAppPathToMobile,
  shouldUseMobileLayout,
} from '#/lib/device-routing'
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
  "img-src 'self' http://localhost:* http://127.0.0.1:* https: data: blob:",
  "media-src 'self' https: data: blob:",
  "connect-src 'self' http://localhost:* http://127.0.0.1:* https: ws: wss:",
  "frame-src 'self' https://*.hcaptcha.com",
  "worker-src 'self' blob:",
].join('; ')

export const Route = createRootRouteWithContext<MyRouterContext>()({
  ssr: false,
  beforeLoad: ({ location }) => {
    if (typeof window === 'undefined') return
    if (!isDesktopRuntime()) {
      if (
        shouldUseMobileLayout() &&
        !isMobileAllowedPath(location.pathname) &&
        !isDesktopOverlayPath(location.pathname)
      ) {
        const mobilePath = mapAppPathToMobile(location.pathname)
        if (mobilePath) {
          throw redirect({
            to: mobilePath,
            search: location.search,
            replace: true,
          })
        }
      }
    }
    if (!isDesktopRuntime()) return
    if (isDesktopAllowedPath(location.pathname)) return
    throw redirect({
      to: DESKTOP_ENTRY_PATH,
      search: { tab: 'online' },
      replace: true,
    })
  },
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1, viewport-fit=cover',
      },
      {
        title: 'syrnike13',
      },
      {
        name: 'description',
        // design-allow hardcoded-string: document metadata is resolved before LocaleProvider mounts
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
        href: '/app-logo.png',
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

  const content = isDesktopOverlayPath(pathname) ? (
    <AppearanceProvider>
      <ThemeColorMeta />
      <Outlet />
      {import.meta.env.DEV ? <PrismTuningOverlay /> : null}
    </AppearanceProvider>
  ) : (
    <TanstackQueryProvider client={queryClient}>
      <AppearanceProvider>
        <ThemeColorMeta />
        {import.meta.env.DEV ? <PrismTuningOverlay /> : null}
        <DesktopStartupUpdateGate>
          <AuthProvider>
            <DiagnosticErrorReporter />
            <SyncProvider>
              <NativeScrollbarEnhancer />
              <Outlet />
              <Toaster richColors closeButton />
            </SyncProvider>
          </AuthProvider>
        </DesktopStartupUpdateGate>
      </AppearanceProvider>
    </TanstackQueryProvider>
  )

  return <AppLocaleProvider>{content}</AppLocaleProvider>
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <head>
        <meta httpEquiv="Content-Security-Policy" content={contentSecurityPolicy} />
        {/* eslint-disable-next-line shadcn/no-inline-styles -- pre-hydration theme CSS must be inline before stylesheets load */}
        <style dangerouslySetInnerHTML={{ __html: getDefaultThemeCss() }} />
        <script dangerouslySetInnerHTML={{ __html: APPEARANCE_BOOTSTRAP_SCRIPT }} />
        <HeadContent />
      </head>
      <body>
        <SquircleNoScript />
        {children}
        <Scripts />
      </body>
    </html>
  )
}
