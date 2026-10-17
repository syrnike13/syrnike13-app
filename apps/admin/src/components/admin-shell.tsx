import { Link, Outlet, useBlocker, useRouterState } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Effect } from 'effect'

import {
  AdminDraftProvider,
  useAdminDraftController,
} from '#/components/draft-controller-context'
import {
  AwardIcon,
  BugIcon,
  LogOutIcon,
  SparklesIcon,
  UserSearchIcon,
} from '#/components/icons'
import { AccessDenied } from '#/components/access-denied'
import { Button } from '@syrnike13/ui/primitives/button'
import { useAuth } from '#/features/auth/auth-context'
import { config } from '#/lib/config'
import { cn } from '#/lib/utils'

const NAV = [
  { to: '/diagnostics', labelKey: 'nav.diagnostics', icon: BugIcon },
  { to: '/badges', labelKey: 'nav.badges', icon: AwardIcon },
  { to: '/users', labelKey: 'nav.users', icon: UserSearchIcon },
  { to: '/feedback', labelKey: 'nav.feedback', icon: SparklesIcon },
] as const

export function AdminShell({ children }: { children?: ReactNode }) {
  return (
    <AdminDraftProvider>
      <AdminShellContent>{children}</AdminShellContent>
    </AdminDraftProvider>
  )
}

function AdminShellContent({ children }: { children?: ReactNode }) {
  const t = useTranslations('shell')
  const auth = useAuth()
  const draftController = useAdminDraftController()

  useBlocker({
    shouldBlockFn: () => {
      if (!draftController?.isDirty) return false
      return !window.confirm(t('leaveConfirm'))
    },
    enableBeforeUnload: () => Boolean(draftController?.isDirty),
  })

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
            <div className="truncate text-[0.8125rem] font-semibold">syrnike13</div>
            <div className="text-[0.625rem] text-muted-foreground">admin</div>
          </div>
        </div>

        <nav className="flex-1 space-y-0.5 px-2 py-2">
          {NAV.map((item) => (
            <NavLink key={item.to} {...item} />
          ))}
        </nav>

        <div className="border-t border-border/60 p-2">
          {config.releaseChannel === 'nightly' ? (
            <div className="mb-2 px-2 text-[0.625rem] font-medium uppercase tracking-wide text-warning">
              Nightly
            </div>
          ) : null}
          <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium">{name}</div>
              {auth.user?.username ? (
                <div className="truncate text-[0.6875rem] text-muted-foreground">
                  @{auth.user.username}
                </div>
              ) : null}
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground"
              aria-label={t('logoutAria')}
              onClick={() => {
                if (
                  draftController?.isDirty &&
                  !window.confirm(t('logoutConfirm'))
                ) {
                  return
                }
                draftController?.reset()
                Effect.runFork(auth.logout())
              }}
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
  labelKey,
  icon: Icon,
}: {
  to: string
  labelKey: string
  icon: typeof AwardIcon
}) {
  const t = useTranslations('shell')
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const active = pathname === to || pathname.startsWith(`${to}/`)

  return (
    <Link
      to={to}
      className={cn(
        'flex h-8 items-center gap-2 rounded-md px-2.5 text-[0.8125rem] transition-colors',
        active
          ? 'bg-sidebar-accent font-medium text-foreground'
          : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground',
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      {t(labelKey)}
    </Link>
  )
}
