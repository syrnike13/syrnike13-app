import { Link, useNavigate } from '@tanstack/react-router'
import {
  BanIcon,
  BellIcon,
  LayoutTemplateIcon,
  LinkIcon,
  ShieldFillIcon,
  ShieldIcon,
  SmileFillIcon,
  Trash2Icon,
  UsersFillIcon,
} from '#/components/icons'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Effect } from 'effect'
import { useTranslations } from '@syrnike13/ui/i18n'

import { ServerSettingsPanelContent } from '#/components/servers/server-settings-panels'
import {
  SERVER_SETTINGS_TAB_LABEL_KEYS,
  SERVER_SETTINGS_TABS,
  type ServerSettingsTab,
} from '#/components/servers/server-settings-types'
import { Button } from '@syrnike13/ui/primitives/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@syrnike13/ui/primitives/dialog'
import {
  SettingsNavItem,
  SettingsNavSection,
  SettingsPageShell,
} from '#/components/settings/settings-page-shell'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
import { deleteOrLeaveServerEffect } from '#/features/api/servers-api'
import { useAuth } from '#/features/auth/auth-context'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { listServerChannels } from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import {
  canOpenServerSettings,
  canViewServerSettingsTab,
  getServerSettingsAccess,
} from '#/features/authorization/authorization'
import { DraftProvider } from '#/components/settings/draft-controller-context'
import { UnsavedChangesBar } from '#/components/settings/unsaved-changes-bar'

type ServerSettingsPageProps = {
  serverId: string
  tab: ServerSettingsTab
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
    <SettingsNavItem
      active={activeTab === tab}
      icon={icon}
      label={label}
      render={
        <Link
          to={`${prefix}/servers/$serverId/settings`}
          params={{ serverId }}
          search={{ tab }}
        />
      }
    />
  )
}

export function ServerSettingsPage({ serverId, tab }: ServerSettingsPageProps) {
  const t = useTranslations('servers.settings')
  const auth = useAuth()
  const navigate = useNavigate()
  const prefix = useAppRoutePrefix()
  const server = useSyncStore((s) => s.servers[serverId])
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deletingServer, setDeletingServer] = useState(false)
  const member = useSyncStore((s) => s.members[`${serverId}:${auth.user?._id}`])
  const channels = useSyncStore((s) =>
    listServerChannels(s, serverId, auth.user?._id),
  )
  const settingsAccess = server
    ? getServerSettingsAccess(
        server,
        member,
        auth.user?._id,
      )
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
    void navigate({ to: prefix || '/', search: { tab: 'online' } })
  }, [channels, navigate, prefix])

  async function deleteOwnedServer() {
    const token = auth.session?.token
    if (!token || !server || server.owner !== auth.user?._id) return

    setDeletingServer(true)
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* deleteOrLeaveServerEffect(token, serverId)
        yield* Effect.sync(() => {
          syncStore.removeServer(serverId)
          syncStore.setSelectedServerId(null)
          setDeleteDialogOpen(false)
        })
        yield* Effect.tryPromise({
          try: () => navigate({ to: prefix || '/', search: { tab: 'online' } }),
          catch: (cause) => cause,
        })
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
          }),
        ),
        Effect.ensuring(Effect.sync(() => setDeletingServer(false))),
      ),
    )
  }

  useEffect(() => {
    if (!server) return
    if (!settingsAccess || !canOpenSettings) {
      void navigate({ to: prefix || '/', search: { tab: 'online' }, replace: true })
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
    <SettingsPageShell
      title={server.name}
      closeLabel={t('close')}
      onClose={closeSettings}
      nav={
        <>
              <SettingsNavSection>
                {canViewTab('overview') ? (
                  <SettingsNavLink
                    serverId={serverId}
                    tab="overview"
                    activeTab={tab}
                    icon={<LayoutTemplateIcon />}
                    label={t(SERVER_SETTINGS_TAB_LABEL_KEYS.overview)}
                  />
                ) : null}
                {canViewTab('engagement') ? (
                  <SettingsNavLink
                    serverId={serverId}
                    tab="engagement"
                    activeTab={tab}
                    icon={<BellIcon />}
                    label={t(SERVER_SETTINGS_TAB_LABEL_KEYS.engagement)}
                  />
                ) : null}
              </SettingsNavSection>

              {canViewTab('emoji') ? (
                <SettingsNavSection title={t('navExpression')}>
                  <SettingsNavLink
                    serverId={serverId}
                    tab="emoji"
                    activeTab={tab}
                    icon={<SmileFillIcon />}
                    label={t(SERVER_SETTINGS_TAB_LABEL_KEYS.emoji)}
                  />
                </SettingsNavSection>
              ) : null}

              {canViewMembersSection ? (
                <SettingsNavSection title={t('navMembers')}>
                  {canViewTab('roles') ? (
                    <SettingsNavLink
                      serverId={serverId}
                      tab="roles"
                      activeTab={tab}
                      icon={<ShieldFillIcon />}
                      label={t(SERVER_SETTINGS_TAB_LABEL_KEYS.roles)}
                    />
                  ) : null}
                  {canViewTab('members') ? (
                    <SettingsNavLink
                      serverId={serverId}
                      tab="members"
                      activeTab={tab}
                      icon={<UsersFillIcon />}
                      label={t(SERVER_SETTINGS_TAB_LABEL_KEYS.members)}
                    />
                  ) : null}
                  {canViewTab('bans') ? (
                    <SettingsNavLink
                      serverId={serverId}
                      tab="bans"
                      activeTab={tab}
                      icon={<BanIcon />}
                      label={t(SERVER_SETTINGS_TAB_LABEL_KEYS.bans)}
                    />
                  ) : null}
                </SettingsNavSection>
              ) : null}

              {canViewAdminSection ? (
                <SettingsNavSection title={t('navAdministration')}>
                  {canViewTab('invites') ? (
                    <SettingsNavLink
                      serverId={serverId}
                      tab="invites"
                      activeTab={tab}
                      icon={<LinkIcon />}
                      label={t(SERVER_SETTINGS_TAB_LABEL_KEYS.invites)}
                    />
                  ) : null}
                  {canViewTab('audit') ? (
                    <SettingsNavLink
                      serverId={serverId}
                      tab="audit"
                      activeTab={tab}
                      icon={<ShieldIcon />}
                      label={t(SERVER_SETTINGS_TAB_LABEL_KEYS.audit)}
                    />
                  ) : null}
                </SettingsNavSection>
              ) : null}

              {server.owner === auth.user?._id ? (
                <SettingsNavSection>
                  <SettingsNavItem
                    destructive
                    disabled={deletingServer}
                    icon={<Trash2Icon />}
                    label={t('deleteServer')}
                    onClick={() => setDeleteDialogOpen(true)}
                  />
                </SettingsNavSection>
              ) : null}
        </>
      }
    >
        <DraftProvider>
          {tab === 'roles' ? (
            <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-6 sm:px-8">
                <div className="flex min-h-0 flex-1 flex-col">
                  <ServerSettingsPanelContent serverId={serverId} tab={tab} />
                </div>
              </div>
            </div>
          ) : (
            <ScrollArea className="min-h-0 flex-1">
              <div className="px-6 py-8 sm:px-8">
                <ServerSettingsPanelContent serverId={serverId} tab={tab} />
              </div>
            </ScrollArea>
          )}
          <UnsavedChangesBar />
        </DraftProvider>
      <Dialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          if (!open && !deletingServer) {
            setDeleteDialogOpen(false)
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('deleteTitle', { name: server.name })}</DialogTitle>
            <DialogDescription>{t('deleteDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={deletingServer}
              onClick={() => setDeleteDialogOpen(false)}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deletingServer}
              onClick={() => void deleteOwnedServer()}
            >
              {t('deleteServer')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsPageShell>
  )
}
