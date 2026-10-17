import { useState, type ReactNode } from 'react'
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@syrnike13/ui/primitives/popover'
import { Separator } from '@syrnike13/ui/primitives/separator'
import { useAuth } from '#/features/auth/auth-context'
import { deleteOrLeaveServerEffect } from '#/features/api/servers-api'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { listServerChannels } from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { writeClipboardTextEffect } from '#/lib/clipboard'
import { getServerMenuPermissions } from '#/features/authorization/authorization'
import { cn } from '#/lib/utils'

type ServerHeaderMenuProps = {
  serverId: string
  serverName: string
  overBanner?: boolean
}

function ServerHeaderMenuItem({
  children,
  icon,
  onClick,
  destructive,
  disabled,
}: {
  children: ReactNode
  icon: ReactNode
  onClick?: () => void
  destructive?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        'flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent',
        destructive && 'text-destructive hover:text-destructive',
        disabled && 'pointer-events-none opacity-50',
      )}
      onClick={onClick}
    >
      <span>{children}</span>
      <span className="shrink-0 opacity-70">{icon}</span>
    </button>
  )
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
          try: () => navigate({ to: '/app', search: { tab: 'online' } }),
          catch: (cause) => cause,
        })
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            toast.error(
              error instanceof Error
                ? error.message
                : isOwner
                  ? t('deleteError')
                  : t('leaveError'),
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
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger render={<button
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
            aria-expanded={menuOpen} />}>
            <span className="min-w-0 flex-1 truncate text-base leading-5 font-semibold">
              {serverName}
            </span>
            <ChevronDownIcon
              className={cn(
                'size-4 shrink-0 opacity-70 transition-transform',
                menuOpen && 'rotate-180',
              )}
            />
          </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={4}
          className="w-(--anchor-width) gap-0 p-1"
        >
          {menuPermissions?.invite ? (
            <ServerHeaderMenuItem
              icon={<UserPlusIcon className="size-4" />}
              onClick={() => openDialog(() => setInviteOpen(true))}
            >
              {t('invite')}
            </ServerHeaderMenuItem>
          ) : null}
          {menuPermissions?.settings ? (
            <ServerHeaderMenuItem
              icon={<SettingsIcon className="size-4" />}
              onClick={() => {
                setMenuOpen(false)
                void navigate({
                  to: `${prefix}/servers/$serverId/settings`,
                  params: { serverId },
                  search: { tab: 'overview' },
                })
              }}
            >
              {t('settings')}
            </ServerHeaderMenuItem>
          ) : null}
          {menuPermissions?.roles ? (
            <ServerHeaderMenuItem
              icon={<ShieldFillIcon className="size-4" />}
              onClick={() => {
                setMenuOpen(false)
                void navigate({
                  to: `${prefix}/servers/$serverId/settings`,
                  params: { serverId },
                  search: { tab: 'roles' },
                })
              }}
            >
              {t('roles')}
            </ServerHeaderMenuItem>
          ) : null}
          {menuPermissions?.audit ? (
            <ServerHeaderMenuItem
              icon={<ShieldIcon className="size-4" />}
              onClick={() => {
                setMenuOpen(false)
                void navigate({
                  to: `${prefix}/servers/$serverId/settings`,
                  params: { serverId },
                  search: { tab: 'audit' },
                })
              }}
            >
              {t('audit')}
            </ServerHeaderMenuItem>
          ) : null}
          {menuPermissions?.createChannel ? (
            <ServerHeaderMenuItem
              icon={<PlusCircleIcon className="size-4" />}
              onClick={() => openDialog(() => setCreateChannelOpen(true))}
            >
              {t('createChannel')}
            </ServerHeaderMenuItem>
          ) : null}
          {menuPermissions?.createChannel ? (
            <ServerHeaderMenuItem
              icon={<FolderPlusIcon className="size-4" />}
              onClick={() => openDialog(() => setCreateCategoryOpen(true))}
            >
              {t('createCategory')}
            </ServerHeaderMenuItem>
          ) : null}
          {showAdminSection &&
          (menuPermissions?.leave || menuPermissions?.copyId) ? (
            <Separator className="my-1" />
          ) : null}
          {menuPermissions?.leave ? (
            <ServerHeaderMenuItem
              icon={
                isOwner ? (
                  <Trash2Icon className="size-4" />
                ) : (
                  <LogOutIcon className="size-4" />
                )
              }
              destructive
              disabled={removingServer}
              onClick={() => {
                setMenuOpen(false)
                setRemoveDialogOpen(true)
              }}
            >
              {isOwner ? t('delete') : t('leave')}
            </ServerHeaderMenuItem>
          ) : null}
          {menuPermissions?.leave && menuPermissions?.copyId ? (
            <Separator className="my-1" />
          ) : null}
          {menuPermissions?.copyId ? (
            <ServerHeaderMenuItem
              icon={<CopyIcon className="size-4" />}
              onClick={() => void copyServerId()}
            >
              {t('copyId')}
            </ServerHeaderMenuItem>
          ) : null}
        </PopoverContent>
      </Popover>

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
