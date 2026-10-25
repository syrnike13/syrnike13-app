import type { ReactElement, ReactNode } from 'react'

import { XIcon } from '#/components/icons'
import { Button } from '@syrnike13/ui/primitives/button'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@syrnike13/ui/primitives/sidebar'

/**
 * Full-screen settings (server, channel): a navigation column on the left,
 * the panel in the middle and a round close button with an Esc hint.
 */
export function SettingsPageShell({
  title,
  nav,
  closeLabel,
  onClose,
  children,
}: {
  title: string
  nav: ReactNode
  closeLabel: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div className="gradient-surface-content settings-page-grid relative grid h-full min-h-0 w-full overflow-hidden bg-card text-card-foreground">
      <aside className="gradient-surface-navigation flex min-h-0 flex-col border-r border-border bg-sidebar">
        <div className="ml-auto flex h-full w-54.5 min-w-0 flex-col">
          <div className="border-b border-border px-4 py-4">
            <h2 className="truncate text-base font-semibold text-foreground">
              {title}
            </h2>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <nav className="flex flex-col">{nav}</nav>
          </ScrollArea>
        </div>
      </aside>

      <div className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        {children}
      </div>

      <div aria-hidden className="min-w-0" />

      <div className="absolute top-4 right-4 z-10 flex flex-col items-center gap-1 sm:right-6 lg:right-8">
        <Button
          type="button"
          variant="outline"
          size="icon-lg"
          shape="circle"
          aria-label={closeLabel}
          onClick={onClose}
        >
          <XIcon />
        </Button>
        <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          esc
        </span>
      </div>
    </div>
  )
}

export function SettingsNavSection({
  title,
  children,
}: {
  title?: string
  children: ReactNode
}) {
  return (
    <SidebarGroup>
      {title ? <SidebarGroupLabel>{title}</SidebarGroupLabel> : null}
      <SidebarMenu>{children}</SidebarMenu>
    </SidebarGroup>
  )
}

/** A navigation row; pass a router link through `render`. */
export function SettingsNavItem({
  active = false,
  icon,
  label,
  render,
  destructive = false,
  disabled,
  onClick,
}: {
  active?: boolean
  icon: ReactNode
  label: string
  render?: ReactElement
  destructive?: boolean
  disabled?: boolean
  onClick?: () => void
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="md"
        isActive={active}
        variant={destructive ? 'destructive' : 'default'}
        disabled={disabled}
        render={render}
        onClick={onClick}
      >
        {icon}
        <span>{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}
