import type { ReactNode } from 'react'

import { Link } from '@tanstack/react-router'

import { Card } from '@syrnike13/ui/primitives/card'
import { Empty } from '@syrnike13/ui/primitives/empty'

import { ArrowLeftIcon } from '#/components/icons'
import { cn } from '#/lib/utils'

export function AdminPage({
  children,
  title,
  back,
  actions,
  className,
  innerClassName,
}: {
  children: ReactNode
  title: string
  back?: { to: string; label: string }
  actions?: ReactNode
  className?: string
  innerClassName?: string
}) {
  return (
    <div className={cn('admin-enter flex min-h-full flex-col', className)}>
      <header className="shrink-0 border-b border-border">
        <div
          className={cn(
            'admin-page-inner flex h-14 items-center justify-between gap-4',
            innerClassName,
          )}
        >
          <div className="flex min-w-0 items-center gap-3">
            {back ? (
              <Link
                to={back.to}
                className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeftIcon className="size-3.5" aria-hidden />
                <span className="hidden sm:inline">{back.label}</span>
              </Link>
            ) : null}
            <h1 className="truncate text-base font-semibold tracking-tight">{title}</h1>
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      </header>
      <div className={cn('admin-page-inner flex-1 py-5', innerClassName)}>
        {children}
      </div>
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
    <Card className={cn('gap-0 py-0', className)}>
      {children}
    </Card>
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
        'border-b border-border px-4 py-2.5 text-xs font-medium text-muted-foreground',
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
    <Empty
      className={cn(
        'border border-dashed px-4 py-10 text-sm text-muted-foreground',
        className,
      )}
    >
      {children}
    </Empty>
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
    <div className="sticky bottom-0 z-10 -mx-(--page-padding-x) mt-5 border-t border-border bg-background/95 px-(--page-padding-x) py-3 backdrop-blur-sm">
      <div className="flex w-full flex-wrap items-center justify-between gap-2">{children}</div>
    </div>
  )
}
