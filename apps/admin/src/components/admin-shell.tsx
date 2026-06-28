import { Link, Outlet } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { AccessDenied } from '#/components/access-denied'
import { Button } from '#/components/ui/button'
import { useAuth } from '#/features/auth/auth-context'
import { config } from '#/lib/config'
import { cn } from '#/lib/utils'

export function AdminShell({ children }: { children?: ReactNode }) {
  const auth = useAuth()

  if (!auth.isPrivileged) {
    return <AccessDenied />
  }

  return (
    <div className="min-h-svh bg-background text-foreground">
      <div className="grid min-h-svh lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="border-b border-border bg-sidebar px-3 py-4 text-sidebar-foreground lg:border-b-0 lg:border-r">
          <div className="flex h-10 items-center justify-between gap-2 px-2">
            <div>
              <div className="text-sm font-semibold">Admin</div>
              {config.releaseChannel === 'nightly' ? (
                <div className="mt-0.5 text-[10px] font-medium uppercase text-yellow-700 dark:text-yellow-300">
                  nightly
                </div>
              ) : null}
            </div>
            <Button variant="ghost" size="sm" onClick={() => void auth.logout()}>
              Выйти
            </Button>
          </div>
          <nav className="mt-3 flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
            <AdminNavLink to="/badges">Бейджи</AdminNavLink>
          </nav>
        </aside>
        <main className="min-w-0 overflow-y-auto">
          {children ?? <Outlet />}
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
        className: cn(
          'bg-sidebar-accent text-sidebar-accent-foreground font-medium',
        ),
      }}
    >
      {children}
    </Link>
  )
}
