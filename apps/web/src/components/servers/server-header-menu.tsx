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
  Trash2Icon,
  UserPlusIcon,
} from '#/components/icons'
import { useNavigate } from '@tanstack/react-router'
import { Effect } from 'effect'
import { toast } from 'sonner'
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
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@syrnike13/ui/primitives/dropdown-menu'
import { useAuth } from '#/features/auth/auth-context'
import { deleteOrLeaveServerEffect } from '#/features/api/servers-api'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { listServerChannels } from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { writeClipboardTextEffect } from '#/lib/clipboard'
import { apiErrorMessage } from '#/lib/api/error-message'
import { getServerMenuPermissions } from '#/features/authorization/authorization'
import { cn } from '#/lib/utils'

type ServerHeaderMenuProps = {
  serverId: string
  serverName: string
  overBanner?: boolean
}

export function ServerHeaderMenu({
  serverId,
  serverName,
  overBanner = false,
}: ServerHeaderMenuProps) {
  const t = useTranslations('servers.menu')
  const auth = useAuth()
  const navigate = useNavigate()
  const prefix = useAppRoutePrefix()
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

  async function handleRemoveServer() {
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
          toast.success(isOwner ? t('deleted') : t('left'))
          setRemoveDialogOpen(false)
        })
        yield* Effect.tryPromise({
          try: () => navigate({ to: '/', search: { tab: 'online' } }),
          catch: (cause) => cause,
        })
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            toast.error(
              apiErrorMessage(
                error,
                isOwner ? t('deleteError') : t('leaveError'),
              ),
            )
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
            Effect.sync(() => toast.error(t('copyError'))),
          onSuccess: () =>
            Effect.sync(() => {
              toast.success(t('copied'))
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
            <button
              type="button"
              className={cn(
                'flex h-8 min-w-0 flex-1 items-center gap-1 rounded-md px-2 text-left transition-colors hover:bg-accent',
                overBanner &&
                  'hover:bg-background/60 hover:backdrop-blur-sm focus-visible:bg-background/60 focus-visible:backdrop-blur-sm',
                menuOpen &&
                  (overBanner
                    ? 'bg-background/60 backdrop-blur-sm'
                    : 'bg-accent'),
              )}
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
        <DropdownMenuContent align="start" sideOffset={4}>
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
                  to: `${prefix}/servers/$serverId/settings`,
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
                  to: `${prefix}/servers/$serverId/settings`,
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
                  to: `${prefix}/servers/$serverId/settings`,
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
          (menuPermissions?.leave || menuPermissions?.copyId) ? (
            <DropdownMenuSeparator />
          ) : null}
          {menuPermissions?.leave ? (
            <DropdownMenuItem
              variant="destructive"
              disabled={removingServer}
              onClick={() => {
                setMenuOpen(false)
                setRemoveDialogOpen(true)
              }}
            >
              {isOwner ? <Trash2Icon /> : <LogOutIcon />}
              {isOwner ? t('delete') : t('leave')}
            </DropdownMenuItem>
          ) : null}
          {menuPermissions?.leave && menuPermissions?.copyId ? (
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

      {menuPermissions?.leave ? (
        <Dialog
          open={removeDialogOpen}
          onOpenChange={(open) => {
            if (!removingServer) setRemoveDialogOpen(open)
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {isOwner
                  ? t('deleteTitle', { name: serverName })
                  : t('leaveTitle', { name: serverName })}
              </DialogTitle>
              <DialogDescription>
                {isOwner ? t('deleteDescription') : t('leaveDescription')}
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
                onClick={() => void handleRemoveServer()}
              >
                {isOwner ? t('delete') : t('leave')}
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
