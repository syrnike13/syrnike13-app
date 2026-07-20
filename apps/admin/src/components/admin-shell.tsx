import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import {
  AwardIcon,
  BugIcon,
  LogOutIcon,
  SparklesIcon,
  UserSearchIcon,
} from '#/components/icons'
import { AccessDenied } from '#/components/access-denied'
import { Button } from '#/components/ui/button'
import { useAuth } from '#/features/auth/auth-context'
import { config } from '#/lib/config'
import { cn } from '#/lib/utils'

const NAV = [
  { to: '/diagnostics', label: 'Диагностика', icon: BugIcon },
  { to: '/badges', label: 'Бейджи', icon: AwardIcon },
  { to: '/users', label: 'Пользователи', icon: UserSearchIcon },
  { to: '/feedback', label: 'Обращения', icon: SparklesIcon },
] as const

export function AdminShell({ children }: { children?: ReactNode }) {
  const auth = useAuth()

  if (!auth.isPrivileged) {
    return <AccessDenied />
  }

  const name = auth.user?.display_name ?? auth.user?.username ?? 'Admin'

  return (
    <div className="flex h-svh overflow-hidden bg-background text-foreground">
      <aside className="flex w-[var(--shell-sidebar-width)] shrink-0 flex-col border-r border-border/60 bg-sidebar">
        <div className="flex h-14 items-center gap-2.5 px-4">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <SparklesIcon className="size-3.5" aria-hidden />
          </span>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[13px] font-semibold">syrnike13</div>
            <div className="text-[10px] text-muted-foreground">admin</div>
          </div>
        </div>

        <nav className="flex-1 space-y-0.5 px-2 py-2">
          {NAV.map((item) => (
            <NavLink key={item.to} {...item} />
          ))}
        </nav>

        <div className="border-t border-border/60 p-2">
          {config.releaseChannel === 'nightly' ? (
            <div className="mb-2 px-2 text-[10px] font-medium uppercase tracking-wide text-warning">
              Nightly
            </div>
          ) : null}
          <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-medium">{name}</div>
              {auth.user?.username ? (
                <div className="truncate text-[11px] text-muted-foreground">
                  @{auth.user.username}
                </div>
              ) : null}
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground"
              aria-label="Выйти"
              onClick={() => void auth.logout()}
            >
              <LogOutIcon className="size-4" aria-hidden />
            </Button>
          </div>
        </div>
      </aside>

      <main className="admin-scroll min-w-0 flex-1 overflow-y-auto bg-surface">
        {children ?? <Outlet />}
      </main>
    </div>
  )
}

function NavLink({
  to,
  label,
  icon: Icon,
}: {
  to: string
  label: string
  icon: typeof AwardIcon
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const active = pathname === to || pathname.startsWith(`${to}/`)

  return (
    <Link
      to={to}
      className={cn(
        'flex h-8 items-center gap-2 rounded-md px-2.5 text-[13px] transition-colors',
        active
          ? 'bg-sidebar-accent font-medium text-foreground'
          : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground',
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      {label}
    </Link>
  )
}
