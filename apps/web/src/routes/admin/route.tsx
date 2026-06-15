import { Link, Outlet, createFileRoute, redirect } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { SettingsIcon, ShieldIcon } from '#/components/icons'
import { AuthedGate } from '#/features/auth/authed-gate'
import { useAuth } from '#/features/auth/auth-context'
import { loadSession } from '#/lib/session'

export const Route = createFileRoute('/admin')({
  beforeLoad: () => {
    if (typeof window === 'undefined') return
    if (!loadSession()) {
      throw redirect({ to: '/login' })
    }
  },
  component: AdminRoute,
})

function AdminRoute() {
  return (
    <AuthedGate>
      <AdminShell />
    </AuthedGate>
  )
}

function AdminShell() {
  const auth = useAuth()

  if (auth.user?.privileged !== true) {
    return <AdminNotFound />
  }

  return (
    <div className="min-h-svh bg-background text-foreground">
      <div className="grid min-h-svh lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="border-b border-border bg-sidebar px-3 py-4 text-sidebar-foreground lg:border-b-0 lg:border-r">
          <div className="flex h-10 items-center gap-2 px-2 text-sm font-semibold">
            <SettingsIcon className="size-4" aria-hidden />
            Admin
          </div>
          <nav className="mt-3 flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
            <AdminNavLink to="/admin/badges">
              <ShieldIcon className="size-4" aria-hidden />
              Бейджи
            </AdminNavLink>
          </nav>
        </aside>
        <main className="min-w-0 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

function AdminNavLink({
  to,
  children,
}: {
  to: string
  children: ReactNode
}) {
  return (
    <Link
      to={to}
      className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-2 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      activeProps={{
        className:
          'bg-sidebar-accent text-sidebar-accent-foreground font-medium',
      }}
    >
      {children}
    </Link>
  )
}

function AdminNotFound() {
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
      </div>
    </div>
  )
}
