import { useState } from 'react'
import {
  ChevronDownIcon,
  CopyIcon,
  FolderPlusIcon,
  LogOutIcon,
  PlusCircleIcon,
  SettingsIcon,
  ShieldFillIcon,
  ShieldIcon,
  UserPlusIcon,
} from '#/components/icons'
import { useNavigate } from '@tanstack/react-router'
import { Effect } from 'effect'
import { useTranslations } from '@syrnike13/ui/i18n'

import { CreateChannelDialog } from '#/components/servers/create-channel-dialog'
import { CreateCategoryDialog } from '#/components/channels/create-category-dialog'
import { ServerInviteDialog } from '#/components/servers/server-invite-dialog'
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
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@syrnike13/ui/primitives/dropdown-menu'
import { useAuth } from '#/features/auth/auth-context'
import { deleteOrLeaveServerEffect } from '@syrnike13/client/api/servers-api'
import { listServerChannels } from '@syrnike13/client/sync/selectors'
import { syncStore, useSyncStore } from '@syrnike13/client/sync/sync-store'
import { writeClipboardTextEffect } from '#/lib/clipboard'
import { getServerMenuPermissions } from '#/features/authorization/authorization'
import { usePrivacy } from '#/features/privacy/use-privacy'
import { cn } from '#/lib/utils'

type ServerHeaderMenuProps = {
  serverId: string
  serverName: string
}

export function ServerHeaderMenu({
  serverId,
  serverName,
}: ServerHeaderMenuProps) {
  const t = useTranslations('servers.menu')
  const auth = useAuth()
  const navigate = useNavigate()
  const server = useSyncStore((s) => s.servers[serverId])
  const member = useSyncStore((s) => s.members[`${serverId}:${auth.user?._id}`])
  const isOwner = server?.owner === auth.user?._id
  const channels = useSyncStore((s) =>
    listServerChannels(s, serverId, auth.user?._id),
  )
  const menuPermissions = server
    ? getServerMenuPermissions(
        server,
        channels,
        member,
        auth.user?._id,
      )
    : null
  const canLeave = Boolean(menuPermissions?.leave && !isOwner)
  const privacy = usePrivacy()
  const dmsAllowed =
    !privacy.privacy.dm_restricted_servers.includes(serverId)

  function setDmsAllowed(allowed: boolean) {
    const restricted = privacy.privacy.dm_restricted_servers.filter(
      (id) => id !== serverId,
    )
    privacy.update({
      ...privacy.privacy,
      dm_restricted_servers: allowed ? restricted : [...restricted, serverId],
    })
  }
  const [menuOpen, setMenuOpen] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [createChannelOpen, setCreateChannelOpen] = useState(false)
  const [createCategoryOpen, setCreateCategoryOpen] = useState(false)
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false)
  const [removingServer, setRemovingServer] = useState(false)

  function openDialog(action: () => void) {
    setMenuOpen(false)
    action()
  }

  async function handleLeaveServer() {
    const token = auth.session?.token
    if (!token || !server) return

    setMenuOpen(false)
    setRemovingServer(true)
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* deleteOrLeaveServerEffect(token, serverId)
        yield* Effect.sync(() => {
          syncStore.removeServer(serverId)
          syncStore.setSelectedServerId(null)
          setRemoveDialogOpen(false)
        })
        yield* Effect.tryPromise({
          try: () => navigate({ to: '/', search: { tab: 'online' } }),
          catch: (cause) => cause,
        })
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
          }),
        ),
        Effect.ensuring(Effect.sync(() => setRemovingServer(false))),
      ),
    )
  }

  const showAdminSection = Boolean(
    menuPermissions?.invite ||
      menuPermissions?.settings ||
      menuPermissions?.roles ||
      menuPermissions?.audit ||
      menuPermissions?.createChannel,
  )

  async function copyServerId() {
    await Effect.runPromise(
      writeClipboardTextEffect(serverId).pipe(
        Effect.matchEffect({
          onFailure: () =>
            Effect.sync(() => {}),
          onSuccess: () =>
            Effect.sync(() => {
              setMenuOpen(false)
            }),
        }),
      ),
    )
  }

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn('min-w-0 justify-start', !menuPermissions?.invite && 'flex-1')}
            />
          }
        >
          <span className="min-w-0 flex-1 truncate text-base leading-5 font-semibold tracking-tight">
            {serverName}
          </span>
          <ChevronDownIcon
            className={cn(
              'size-4 shrink-0 opacity-70 transition-transform',
              menuOpen && 'rotate-180',
            )}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={4} className="min-w-56">
          {menuPermissions?.invite ? (
            <DropdownMenuItem
              onClick={() => openDialog(() => setInviteOpen(true))}
            >
              <UserPlusIcon />
              {t('invite')}
            </DropdownMenuItem>
          ) : null}
          {menuPermissions?.settings ? (
            <DropdownMenuItem
              onClick={() => {
                setMenuOpen(false)
                void navigate({
                  to: '/servers/$serverId/settings',
                  params: { serverId },
                  search: { tab: 'overview' },
                })
              }}
            >
              <SettingsIcon />
              {t('settings')}
            </DropdownMenuItem>
          ) : null}
          {menuPermissions?.roles ? (
            <DropdownMenuItem
              onClick={() => {
                setMenuOpen(false)
                void navigate({
                  to: '/servers/$serverId/settings',
                  params: { serverId },
                  search: { tab: 'roles' },
                })
              }}
            >
              <ShieldFillIcon />
              {t('roles')}
            </DropdownMenuItem>
          ) : null}
          {menuPermissions?.audit ? (
            <DropdownMenuItem
              onClick={() => {
                setMenuOpen(false)
                void navigate({
                  to: '/servers/$serverId/settings',
                  params: { serverId },
                  search: { tab: 'audit' },
                })
              }}
            >
              <ShieldIcon />
              {t('audit')}
            </DropdownMenuItem>
          ) : null}
          {menuPermissions?.createChannel ? (
            <DropdownMenuItem
              onClick={() => openDialog(() => setCreateChannelOpen(true))}
            >
              <PlusCircleIcon />
              {t('createChannel')}
            </DropdownMenuItem>
          ) : null}
          {menuPermissions?.createChannel ? (
            <DropdownMenuItem
              onClick={() => openDialog(() => setCreateCategoryOpen(true))}
            >
              <FolderPlusIcon />
              {t('createCategory')}
            </DropdownMenuItem>
          ) : null}
          {showAdminSection &&
          (canLeave || menuPermissions?.copyId) ? (
            <DropdownMenuSeparator />
          ) : null}
          {member ? (
            <DropdownMenuCheckboxItem
              checked={dmsAllowed}
              closeOnClick={false}
              disabled={!privacy.loaded}
              description={t('allowDirectMessagesHint')}
              onCheckedChange={setDmsAllowed}
            >
              {t('allowDirectMessages')}
            </DropdownMenuCheckboxItem>
          ) : null}
          {canLeave ? (
            <DropdownMenuItem
              disabled={removingServer}
              onClick={() => {
                setMenuOpen(false)
                setRemoveDialogOpen(true)
              }}
            >
              <LogOutIcon />
              {t('leave')}
            </DropdownMenuItem>
          ) : null}
          {canLeave && menuPermissions?.copyId ? (
            <DropdownMenuSeparator />
          ) : null}
          {menuPermissions?.copyId ? (
            <DropdownMenuItem onClick={() => void copyServerId()}>
              <CopyIcon />
              {t('copyId')}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {menuPermissions?.invite ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-auto"
          aria-label={t('invite')}
          title={t('invite')}
          onClick={() => setInviteOpen(true)}
        >
          <UserPlusIcon className="size-5" />
        </Button>
      ) : null}

      {canLeave ? (
        <Dialog
          open={removeDialogOpen}
          onOpenChange={(open) => {
            if (!removingServer) setRemoveDialogOpen(open)
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {t('leaveTitle', { name: serverName })}
              </DialogTitle>
              <DialogDescription>
                {t('leaveDescription')}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={removingServer}
                onClick={() => setRemoveDialogOpen(false)}
              >
                {t('cancel')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={removingServer}
                onClick={() => void handleLeaveServer()}
              >
                {t('leave')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {menuPermissions?.invite ? (
        <ServerInviteDialog
          serverId={serverId}
          open={inviteOpen}
          onOpenChange={setInviteOpen}
        />
      ) : null}
      {menuPermissions?.createChannel ? (
        <>
          <CreateChannelDialog
            serverId={serverId}
            open={createChannelOpen}
            onOpenChange={setCreateChannelOpen}
          />
          <CreateCategoryDialog
            serverId={serverId}
            open={createCategoryOpen}
            onOpenChange={setCreateCategoryOpen}
          />
        </>
      ) : null}
    </>
  )
}
