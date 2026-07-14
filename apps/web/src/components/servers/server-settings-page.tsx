import { Link, useNavigate } from '@tanstack/react-router'
import {
  BanIcon,
  LayoutTemplateIcon,
  LinkIcon,
  ShieldFillIcon,
  ShieldIcon,
  SmileFillIcon,
  UsersFillIcon,
  XIcon,
} from '#/components/icons'
import { useCallback, useEffect, type ReactNode } from 'react'

import { ServerSettingsPanelContent } from '#/components/servers/server-settings-panels'
import {
  SERVER_SETTINGS_TAB_LABELS,
  SERVER_SETTINGS_TABS,
  type ServerSettingsTab,
} from '#/components/servers/server-settings-types'
import { Button } from '#/components/ui/button'
import { ScrollArea } from '#/components/ui/scroll-area'
import { useAuth } from '#/features/auth/auth-context'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { listServerChannels } from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import {
  canOpenServerSettings,
  canViewServerSettingsTab,
  getServerSettingsAccess,
} from '#/lib/permissions'
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
  const prefix = useAppRoutePrefix()
  return (
    <Link
      to={`${prefix}/servers/$serverId/settings`}
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
  const prefix = useAppRoutePrefix()
  const server = useSyncStore((s) => s.servers[serverId])
  const member = useSyncStore((s) => s.members[`${serverId}:${auth.user?._id}`])
  const channels = useSyncStore((s) =>
    listServerChannels(s, serverId, auth.user?._id),
  )
  const settingsAccess = server
    ? getServerSettingsAccess(server, member, auth.user?._id)
    : null
  const canOpenSettings = settingsAccess
    ? canOpenServerSettings(settingsAccess)
    : false
  const canViewCurrentTab = settingsAccess
    ? canViewServerSettingsTab(settingsAccess, tab)
    : false
  const closeSettings = useCallback(() => {
    const textChannel = channels.find(
      (channel) => channel.channel_type === 'TextChannel',
    )
    if (textChannel) {
      void navigate({
        to: `${prefix}/c/$channelId`,
        params: { channelId: textChannel._id },
        search: { m: undefined },
      })
      return
    }
    void navigate({ to: prefix, search: { tab: 'online' } })
  }, [channels, navigate, prefix])

  useEffect(() => {
    if (!server) return
    if (!settingsAccess || !canOpenSettings) {
      void navigate({ to: prefix, search: { tab: 'online' }, replace: true })
      return
    }
    if (!canViewCurrentTab) {
      const firstTab = SERVER_SETTINGS_TABS.find((candidate) =>
        canViewServerSettingsTab(settingsAccess, candidate),
      )
      void navigate({
        to: `${prefix}/servers/$serverId/settings`,
        params: { serverId },
        search: { tab: firstTab ?? 'overview' },
        replace: true,
      })
    }
  }, [
    canOpenSettings,
    canViewCurrentTab,
    navigate,
    prefix,
    server,
    serverId,
    settingsAccess,
  ])

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

  if (!server || !settingsAccess || !canOpenSettings || !canViewCurrentTab) {
    return null
  }

  const canViewTab = (candidate: ServerSettingsTab) =>
    canViewServerSettingsTab(settingsAccess, candidate)
  const canViewMembersSection =
    canViewTab('roles') || canViewTab('members') || canViewTab('bans')
  const canViewAdminSection = canViewTab('invites') || canViewTab('audit')

  return (
    <div
      className="gradient-surface-content relative grid h-full min-h-0 w-full overflow-hidden bg-background"
      style={{ gridTemplateColumns: SETTINGS_GRID_COLUMNS }}
    >
      <aside className="gradient-surface-navigation flex min-h-0 flex-col border-r border-border bg-muted/40">
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
                {canViewTab('overview') ? (
                  <SettingsNavLink
                    serverId={serverId}
                    tab="overview"
                    activeTab={tab}
                    icon={<LayoutTemplateIcon className="size-4 shrink-0" />}
                    label={SERVER_SETTINGS_TAB_LABELS.overview}
                  />
                ) : null}
              </NavSection>

              {canViewTab('emoji') ? (
                <NavSection title="Выражение">
                  <SettingsNavLink
                    serverId={serverId}
                    tab="emoji"
                    activeTab={tab}
                    icon={<SmileFillIcon className="size-4 shrink-0" />}
                    label={SERVER_SETTINGS_TAB_LABELS.emoji}
                  />
                </NavSection>
              ) : null}

              {canViewMembersSection ? (
                <NavSection title="Участники">
                  {canViewTab('roles') ? (
                    <SettingsNavLink
                      serverId={serverId}
                      tab="roles"
                      activeTab={tab}
                      icon={<ShieldFillIcon className="size-4 shrink-0" />}
                      label={SERVER_SETTINGS_TAB_LABELS.roles}
                    />
                  ) : null}
                  {canViewTab('members') ? (
                    <SettingsNavLink
                      serverId={serverId}
                      tab="members"
                      activeTab={tab}
                      icon={<UsersFillIcon className="size-4 shrink-0" />}
                      label={SERVER_SETTINGS_TAB_LABELS.members}
                    />
                  ) : null}
                  {canViewTab('bans') ? (
                    <SettingsNavLink
                      serverId={serverId}
                      tab="bans"
                      activeTab={tab}
                      icon={<BanIcon className="size-4 shrink-0" />}
                      label={SERVER_SETTINGS_TAB_LABELS.bans}
                    />
                  ) : null}
                </NavSection>
              ) : null}

              {canViewAdminSection ? (
                <NavSection title="Администрирование">
                  {canViewTab('invites') ? (
                    <SettingsNavLink
                      serverId={serverId}
                      tab="invites"
                      activeTab={tab}
                      icon={<LinkIcon className="size-4 shrink-0" />}
                      label={SERVER_SETTINGS_TAB_LABELS.invites}
                    />
                  ) : null}
                  {canViewTab('audit') ? (
                    <SettingsNavLink
                      serverId={serverId}
                      tab="audit"
                      activeTab={tab}
                      icon={<ShieldIcon className="size-4 shrink-0" />}
                      label={SERVER_SETTINGS_TAB_LABELS.audit}
                    />
                  ) : null}
                </NavSection>
              ) : null}
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
