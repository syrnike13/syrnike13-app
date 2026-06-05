import { Link, useNavigate } from '@tanstack/react-router'
import {
  LayoutTemplateIcon,
  ShieldIcon,
  SmileIcon,
  UsersIcon,
  XIcon,
} from 'lucide-react'
import { useCallback, useEffect, type ReactNode } from 'react'

import { ServerSettingsPanelContent } from '#/components/servers/server-settings-panels'
import {
  SERVER_SETTINGS_TAB_LABELS,
  type ServerSettingsTab,
} from '#/components/servers/server-settings-types'
import { Button } from '#/components/ui/button'
import { ScrollArea } from '#/components/ui/scroll-area'
import { useAuth } from '#/features/auth/auth-context'
import { listServerChannels } from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { getServerMenuPermissions } from '#/lib/permissions'
import { DraftProvider } from '#/components/settings/draft-controller-context'
import { UnsavedChangesBar } from '#/components/settings/unsaved-changes-bar'
import { cn } from '#/lib/utils'

type ServerSettingsPageProps = {
  serverId: string
  tab: ServerSettingsTab
}

const SETTINGS_SHELL_MAX = '64rem'
const SETTINGS_NAV_WIDTH = '218px'
const SETTINGS_GRID_COLUMNS = `calc((100vw - min(100vw, ${SETTINGS_SHELL_MAX})) / 2 + ${SETTINGS_NAV_WIDTH}) minmax(0, calc(${SETTINGS_SHELL_MAX} - ${SETTINGS_NAV_WIDTH})) calc((100vw - min(100vw, ${SETTINGS_SHELL_MAX})) / 2)`

function settingsNavItemClass(active: boolean) {
  return cn(
    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
    active
      ? 'bg-accent font-medium text-accent-foreground'
      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
  )
}

function NavSection({
  title,
  children,
}: {
  title?: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {title ? (
        <p className="px-2 py-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {title}
        </p>
      ) : null}
      {children}
    </div>
  )
}

function SettingsNavLink({
  serverId,
  tab,
  activeTab,
  icon,
  label,
}: {
  serverId: string
  tab: ServerSettingsTab
  activeTab: ServerSettingsTab
  icon: ReactNode
  label: string
}) {
  return (
    <Link
      to="/app/servers/$serverId/settings"
      params={{ serverId }}
      search={{ tab }}
      className={settingsNavItemClass(activeTab === tab)}
    >
      {icon}
      {label}
    </Link>
  )
}

export function ServerSettingsPage({ serverId, tab }: ServerSettingsPageProps) {
  const auth = useAuth()
  const navigate = useNavigate()
  const server = useSyncStore((s) => s.servers[serverId])
  const member = useSyncStore((s) => s.members[`${serverId}:${auth.user?._id}`])
  const channels = useSyncStore((s) => listServerChannels(s, serverId))
  const menuPermissions = server
    ? getServerMenuPermissions(server, channels, member, auth.user?._id)
    : null
  const closeSettings = useCallback(() => {
    const textChannel = channels.find(
      (channel) => channel.channel_type === 'TextChannel',
    )
    if (textChannel) {
      void navigate({
        to: '/app/c/$channelId',
        params: { channelId: textChannel._id },
        search: { m: undefined },
      })
      return
    }
    void navigate({ to: '/app', search: { tab: 'online' } })
  }, [channels, navigate])

  useEffect(() => {
    if (!server) return
    if (!menuPermissions?.settings) {
      void navigate({ to: '/app', search: { tab: 'online' }, replace: true })
    }
  }, [menuPermissions?.settings, navigate, server])

  useEffect(() => {
    syncStore.setSelectedServerId(serverId)
  }, [serverId])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      if (event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (
        target?.closest(
          'input, textarea, select, [contenteditable="true"], [role="dialog"]',
        )
      ) {
        return
      }
      closeSettings()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeSettings])

  if (!server || !menuPermissions?.settings) {
    return null
  }

  return (
    <div
      className="relative grid h-full min-h-0 w-full overflow-hidden bg-background"
      style={{ gridTemplateColumns: SETTINGS_GRID_COLUMNS }}
    >
      <aside className="flex min-h-0 flex-col border-r border-border bg-muted/40">
        <div
          className="ml-auto flex h-full min-w-0 flex-col"
          style={{ width: SETTINGS_NAV_WIDTH }}
        >
          <div className="border-b border-border/60 px-3 py-4">
            <p className="truncate text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              {server.name}
            </p>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <nav className="flex flex-col gap-3 p-2">
              <NavSection>
                <SettingsNavLink
                  serverId={serverId}
                  tab="general"
                  activeTab={tab}
                  icon={<LayoutTemplateIcon className="size-4 shrink-0" />}
                  label={SERVER_SETTINGS_TAB_LABELS.general}
                />
              </NavSection>

              <NavSection title="Выражение">
                <SettingsNavLink
                  serverId={serverId}
                  tab="emoji"
                  activeTab={tab}
                  icon={<SmileIcon className="size-4 shrink-0" />}
                  label={SERVER_SETTINGS_TAB_LABELS.emoji}
                />
              </NavSection>

              <NavSection title="Участники">
                <SettingsNavLink
                  serverId={serverId}
                  tab="roles"
                  activeTab={tab}
                  icon={<ShieldIcon className="size-4 shrink-0" />}
                  label={SERVER_SETTINGS_TAB_LABELS.roles}
                />
                <SettingsNavLink
                  serverId={serverId}
                  tab="members"
                  activeTab={tab}
                  icon={<UsersIcon className="size-4 shrink-0" />}
                  label={SERVER_SETTINGS_TAB_LABELS.members}
                />
              </NavSection>
            </nav>
          </ScrollArea>
        </div>
      </aside>

      <div className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        <DraftProvider>
          {tab === 'roles' ? (
            <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-6 sm:px-8">
                <div className="flex min-h-0 flex-1 flex-col">
                  <ServerSettingsPanelContent serverId={serverId} tab={tab} />
                </div>
              </div>
              <UnsavedChangesBar saveLabel="Сохранить" />
            </div>
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <div className="px-6 py-8 sm:px-8">
                <ServerSettingsPanelContent serverId={serverId} tab={tab} />
              </div>
            </ScrollArea>
          )}
        </DraftProvider>
      </div>

      <div aria-hidden className="min-w-0" />

      <div className="absolute top-4 right-4 z-10 flex flex-col items-center gap-1 sm:right-6 lg:right-8">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-9 rounded-full border border-border/60 bg-background/80 shadow-sm backdrop-blur-sm"
          onClick={closeSettings}
        >
          <XIcon className="size-4" />
          <span className="sr-only">Закрыть</span>
        </Button>
        <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
          esc
        </span>
      </div>
    </div>
  )
}
