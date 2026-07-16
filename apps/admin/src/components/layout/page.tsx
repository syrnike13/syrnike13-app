import type { ReactNode } from 'react'

import { Link } from '@tanstack/react-router'

import { ArrowLeftIcon } from '#/components/icons'
import { cn } from '#/lib/utils'

export function AdminPage({
  children,
  title,
  back,
  actions,
  className,
}: {
  children: ReactNode
  title: string
  back?: { to: string; label: string }
  actions?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('admin-enter flex min-h-full flex-col', className)}>
      <header className="shrink-0 border-b border-border/60">
        <div className="admin-page-inner flex h-14 items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            {back ? (
              <Link
                to={back.to}
                className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeftIcon className="size-3.5" aria-hidden />
                <span className="hidden sm:inline">{back.label}</span>
              </Link>
            ) : null}
            <h1 className="truncate text-[15px] font-semibold tracking-tight">{title}</h1>
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      </header>
      <div className="admin-page-inner flex-1 py-5">{children}</div>
    </div>
  )
}

export function AdminSection({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={cn(
        'overflow-hidden rounded-md border border-border/70 bg-card',
        className,
      )}
    >
      {children}
    </section>
  )
}

export function AdminSectionHeader({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'border-b border-border/60 px-4 py-2.5 text-[12px] font-medium text-muted-foreground',
        className,
      )}
    >
      {children}
    </div>
  )
}

export function AdminEmpty({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'rounded-md border border-dashed border-border/70 px-4 py-10 text-center text-[13px] text-muted-foreground',
        className,
      )}
    >
      {children}
    </div>
  )
}

export function AdminStickyFooter({
  children,
  visible,
}: {
  children: ReactNode
  visible?: boolean
}) {
  if (!visible) return null

  return (
    <div className="sticky bottom-0 z-10 -mx-[var(--page-padding-x)] mt-5 border-t border-border/60 bg-surface/95 px-[var(--page-padding-x)] py-3 backdrop-blur-sm">
      <div className="flex w-full flex-wrap items-center justify-between gap-2">{children}</div>
    </div>
  )
}
