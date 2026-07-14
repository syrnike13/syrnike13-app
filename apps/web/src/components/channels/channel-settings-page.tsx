import { Link, useNavigate } from '@tanstack/react-router'
import {
  LayoutTemplateIcon,
  LinkIcon,
  ShieldFillIcon,
  XIcon,
} from '#/components/icons'
import { useCallback, useEffect, type ReactNode } from 'react'

import { ChannelSettingsPanelContent } from '#/components/channels/channel-settings-panels'
import {
  CHANNEL_SETTINGS_TAB_LABELS,
  type ChannelSettingsTab,
} from '#/components/channels/channel-settings-types'
import {
  channelSettingsSearch,
  clearChannelSettingsSearch,
} from '#/lib/channel-settings-navigation'
import { Button } from '#/components/ui/button'
import { ScrollArea } from '#/components/ui/scroll-area'
import { DraftProvider } from '#/components/settings/draft-controller-context'
import { UnsavedChangesBar } from '#/components/settings/unsaved-changes-bar'
import { useAuth } from '#/features/auth/auth-context'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import {
  isServerChannel,
  runtimeChannelName,
  serverChannelServerId,
  type RuntimeChannel,
} from '#/lib/channel-voice'
import {
  canManageChannel,
  canManageChannelPermissions,
  canManageChannelWebhooks,
} from '#/lib/permissions'
import { cn } from '#/lib/utils'

type ChannelSettingsPageProps = {
  channelId: string
  hostChannelId: string
  tab: ChannelSettingsTab
  highlightMessageId?: string
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
  hostChannelId,
  channelId,
  tab,
  activeTab,
  icon,
  label,
  highlightMessageId,
}: {
  hostChannelId: string
  channelId: string
  tab: ChannelSettingsTab
  activeTab: ChannelSettingsTab
  icon: ReactNode
  label: string
  highlightMessageId?: string
}) {
  const prefix = useAppRoutePrefix()
  return (
    <Link
      to={`${prefix}/c/$channelId`}
      params={{ channelId: hostChannelId }}
      search={channelSettingsSearch({
        settingsChannel: channelId,
        settingsTab: tab,
        m: highlightMessageId,
      })}
      className={settingsNavItemClass(activeTab === tab)}
    >
      {icon}
      {label}
    </Link>
  )
}

export function ChannelSettingsPage({
  channelId,
  hostChannelId,
  tab,
  highlightMessageId,
}: ChannelSettingsPageProps) {
  const auth = useAuth()
  const navigate = useNavigate()
  const prefix = useAppRoutePrefix()
  const channel = useSyncStore((s) => s.channels[channelId])
  const settingsChannel = channel as RuntimeChannel | undefined
  const serverId = serverChannelServerId(settingsChannel)
  const server = useSyncStore((s) => (serverId ? s.servers[serverId] : undefined))
  const member = useSyncStore((s) =>
    serverId && auth.user?._id
      ? s.members[`${serverId}:${auth.user._id}`]
      : undefined,
  )

  const isServerSettingsChannel = isServerChannel(settingsChannel)

  const canManage =
    isServerSettingsChannel && settingsChannel
      ? canManageChannel(server, settingsChannel, member, auth.user?._id)
      : false

  const canManagePermissions =
    isServerSettingsChannel && settingsChannel
      ? canManageChannelPermissions(
          server,
          settingsChannel,
          member,
          auth.user?._id,
        )
      : false
  const canManageWebhooks =
    isServerSettingsChannel && settingsChannel.channel_type === 'TextChannel'
      ? canManageChannelWebhooks(server, settingsChannel, member, auth.user?._id)
      : false

  const closeSettings = useCallback(() => {
    void navigate({
      to: `${prefix}/c/$channelId`,
      params: { channelId: hostChannelId },
      search: clearChannelSettingsSearch(highlightMessageId),
    })
  }, [highlightMessageId, hostChannelId, navigate, prefix])

  useEffect(() => {
    if (!settingsChannel) return

    if (!isServerSettingsChannel) {
      void navigate({ to: prefix, search: { tab: 'online' }, replace: true })
      return
    }

    if (!server || !auth.user?._id) return

    if (!canManage && !canManagePermissions && !canManageWebhooks) {
      void navigate({
        to: `${prefix}/c/$channelId`,
        params: { channelId: hostChannelId },
        search: clearChannelSettingsSearch(highlightMessageId),
        replace: true,
      })
    }
  }, [
    auth.user?._id,
    canManage,
    canManagePermissions,
    canManageWebhooks,
    channelId,
    highlightMessageId,
    hostChannelId,
    isServerSettingsChannel,
    navigate,
    prefix,
    server,
    settingsChannel,
  ])

  useEffect(() => {
    if (serverId) {
      syncStore.setSelectedServerId(serverId)
    }
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

  if (!settingsChannel || !isServerSettingsChannel) {
    return null
  }

  if (!server || !auth.user?._id) {
    return null
  }

  if (!canManage && !canManagePermissions && !canManageWebhooks) {
    return null
  }

  let effectiveTab = tab
  const canOpenRequestedTab =
    (effectiveTab === 'overview' && canManage) ||
    (effectiveTab === 'permissions' && canManagePermissions) ||
    (effectiveTab === 'webhooks' && canManageWebhooks)
  if (!canOpenRequestedTab) {
    effectiveTab = canManage
      ? 'overview'
      : canManagePermissions
        ? 'permissions'
        : 'webhooks'
  }

  const channelLabel =
    settingsChannel.channel_type === 'TextChannel'
      ? `#${settingsChannel.name}`
      : (runtimeChannelName(settingsChannel) ?? settingsChannel._id)

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
              {channelLabel}
            </p>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <nav className="flex flex-col gap-3 p-2">
              {canManage ? (
                <NavSection>
                  <SettingsNavLink
                    hostChannelId={hostChannelId}
                    channelId={channelId}
                    tab="overview"
                    activeTab={effectiveTab}
                    highlightMessageId={highlightMessageId}
                    icon={<LayoutTemplateIcon className="size-4 shrink-0" />}
                    label={CHANNEL_SETTINGS_TAB_LABELS.overview}
                  />
                </NavSection>
              ) : null}

              {canManagePermissions ? (
                <NavSection title="Доступ">
                  <SettingsNavLink
                    hostChannelId={hostChannelId}
                    channelId={channelId}
                    tab="permissions"
                    activeTab={effectiveTab}
                    highlightMessageId={highlightMessageId}
                    icon={<ShieldFillIcon className="size-4 shrink-0" />}
                    label={CHANNEL_SETTINGS_TAB_LABELS.permissions}
                  />
                </NavSection>
              ) : null}

              {canManageWebhooks ? (
                <NavSection title="Инструменты">
                  <SettingsNavLink
                    hostChannelId={hostChannelId}
                    channelId={channelId}
                    tab="webhooks"
                    activeTab={effectiveTab}
                    highlightMessageId={highlightMessageId}
                    icon={<LinkIcon className="size-4 shrink-0" />}
                    label={CHANNEL_SETTINGS_TAB_LABELS.webhooks}
                  />
                </NavSection>
              ) : null}
            </nav>
          </ScrollArea>
        </div>
      </aside>

      <div className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        <DraftProvider>
          {effectiveTab === 'permissions' ? (
            <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-6 sm:px-8">
                <div className="flex min-h-0 flex-1 flex-col">
                  <ChannelSettingsPanelContent
                    channel={settingsChannel}
                    tab={effectiveTab}
                  />
                </div>
              </div>
              <UnsavedChangesBar saveLabel="Сохранить" />
            </div>
          ) : (
            <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
              <ScrollArea className="min-h-0 flex-1">
                <div className="scroll-pb-24 px-6 py-8 sm:px-8">
                  <ChannelSettingsPanelContent
                    channel={settingsChannel}
                    tab={effectiveTab}
                  />
                </div>
              </ScrollArea>
              <UnsavedChangesBar saveLabel="Сохранить" />
            </div>
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
