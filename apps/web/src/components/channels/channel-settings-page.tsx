import { Link, useNavigate } from '@tanstack/react-router'
import { useTranslations } from '@syrnike13/ui/i18n'
import {
  LayoutTemplateIcon,
  LinkIcon,
  ShieldFillIcon,
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
import {
  SettingsNavItem,
  SettingsNavSection,
  SettingsPageShell,
} from '#/components/settings/settings-page-shell'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
import { DraftProvider } from '#/components/settings/draft-controller-context'
import { UnsavedChangesBar } from '#/components/settings/unsaved-changes-bar'
import { useAuth } from '#/features/auth/auth-context'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import {
  isServerChannel,
  serverChannelServerId,
} from '#/lib/channel-voice'
import {
  canManageChannel,
  canManageChannelPermissions,
  canManageChannelWebhooks,
} from '#/features/authorization/authorization'

type ChannelSettingsPageProps = {
  channelId: string
  hostChannelId: string
  tab: ChannelSettingsTab
  highlightMessageId?: string
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
    <SettingsNavItem
      active={activeTab === tab}
      icon={icon}
      label={label}
      render={
        <Link
          to={`${prefix}/c/$channelId`}
          params={{ channelId: hostChannelId }}
          search={channelSettingsSearch({
            settingsChannel: channelId,
            settingsTab: tab,
            m: highlightMessageId,
          })}
        />
      }
    />
  )
}

export function ChannelSettingsPage({
  channelId,
  hostChannelId,
  tab,
  highlightMessageId,
}: ChannelSettingsPageProps) {
  const t = useTranslations('channels')
  const auth = useAuth()
  const navigate = useNavigate()
  const prefix = useAppRoutePrefix()
  const channel = useSyncStore((s) => s.channels[channelId])
  const settingsChannel = channel
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
      ? canManageChannel(
          server,
          settingsChannel,
          member,
          auth.user?._id,
        )
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
      ? canManageChannelWebhooks(
          server,
          settingsChannel,
          member,
          auth.user?._id,
        )
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
      void navigate({ to: prefix || '/', search: { tab: 'online' }, replace: true })
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

  const channelLabel = `#${settingsChannel.name}`

  return (
    <SettingsPageShell
      title={channelLabel}
      closeLabel={t('close')}
      onClose={closeSettings}
      nav={
        <>
              {canManage ? (
                <SettingsNavSection>
                  <SettingsNavLink
                    hostChannelId={hostChannelId}
                    channelId={channelId}
                    tab="overview"
                    activeTab={effectiveTab}
                    highlightMessageId={highlightMessageId}
                    icon={<LayoutTemplateIcon />}
                    label={t(`tabs.${CHANNEL_SETTINGS_TAB_LABELS.overview}`)}
                  />
                </SettingsNavSection>
              ) : null}

              {canManagePermissions ? (
                <SettingsNavSection title={t('nav.access')}>
                  <SettingsNavLink
                    hostChannelId={hostChannelId}
                    channelId={channelId}
                    tab="permissions"
                    activeTab={effectiveTab}
                    highlightMessageId={highlightMessageId}
                    icon={<ShieldFillIcon />}
                    label={t(`tabs.${CHANNEL_SETTINGS_TAB_LABELS.permissions}`)}
                  />
                </SettingsNavSection>
              ) : null}

              {canManageWebhooks ? (
                <SettingsNavSection title={t('nav.tools')}>
                  <SettingsNavLink
                    hostChannelId={hostChannelId}
                    channelId={channelId}
                    tab="webhooks"
                    activeTab={effectiveTab}
                    highlightMessageId={highlightMessageId}
                    icon={<LinkIcon />}
                    label={t(`tabs.${CHANNEL_SETTINGS_TAB_LABELS.webhooks}`)}
                  />
                </SettingsNavSection>
              ) : null}
        </>
      }
    >
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
              <UnsavedChangesBar saveLabel={t('save')} />
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
              <UnsavedChangesBar saveLabel={t('save')} />
            </div>
          )}
        </DraftProvider>
    </SettingsPageShell>
  )
}
