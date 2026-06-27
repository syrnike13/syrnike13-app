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
import { toast } from 'sonner'

import { CreateChannelDialog } from '#/components/servers/create-channel-dialog'
import { CreateCategoryDialog } from '#/components/channels/create-category-dialog'
import { ServerInviteDialog } from '#/components/servers/server-invite-dialog'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { Separator } from '#/components/ui/separator'
import { useAuth } from '#/features/auth/auth-context'
import { deleteOrLeaveServer } from '#/features/api/servers-api'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { listServerChannels } from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { writeClipboardText } from '#/lib/clipboard'
import { getServerMenuPermissions } from '#/lib/permissions'
import { cn } from '#/lib/utils'

type ServerHeaderMenuProps = {
  serverId: string
  serverName: string
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
}: ServerHeaderMenuProps) {
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
    ? getServerMenuPermissions(server, channels, member, auth.user?._id)
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
    try {
      await deleteOrLeaveServer(token, serverId)
      syncStore.removeServer(serverId)
      syncStore.setSelectedServerId(null)
      toast.success(isOwner ? 'Сервер удалён' : 'Вы покинули сервер')
      setRemoveDialogOpen(false)
      await navigate({ to: '/app', search: { tab: 'online' } })
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : isOwner
            ? 'Не удалось удалить сервер'
            : 'Не удалось покинуть сервер',
      )
    } finally {
      setRemovingServer(false)
    }
  }

  const showAdminSection = Boolean(
    menuPermissions?.invite ||
      menuPermissions?.settings ||
      menuPermissions?.roles ||
      menuPermissions?.audit ||
      menuPermissions?.createChannel,
  )

  async function copyServerId() {
    try {
      await writeClipboardText(serverId)
      toast.success('ID сервера скопирован')
      setMenuOpen(false)
    } catch {
      toast.error('Не удалось скопировать')
    }
  }

  return (
    <>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent',
              menuOpen && 'bg-accent',
            )}
            aria-expanded={menuOpen}
          >
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {serverName}
            </span>
            <ChevronDownIcon
              className={cn(
                'size-4 shrink-0 opacity-70 transition-transform',
                menuOpen && 'rotate-180',
              )}
            />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={4}
          className="w-[var(--radix-popover-trigger-width)] p-1"
        >
          {menuPermissions?.invite ? (
            <ServerHeaderMenuItem
              icon={<UserPlusIcon className="size-4" />}
              onClick={() => openDialog(() => setInviteOpen(true))}
            >
              Пригласить на сервер
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
              Настройки сервера
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
              Роли
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
              Журнал аудита
            </ServerHeaderMenuItem>
          ) : null}
          {menuPermissions?.createChannel ? (
            <ServerHeaderMenuItem
              icon={<PlusCircleIcon className="size-4" />}
              onClick={() => openDialog(() => setCreateChannelOpen(true))}
            >
              Создать канал
            </ServerHeaderMenuItem>
          ) : null}
          {menuPermissions?.createChannel ? (
            <ServerHeaderMenuItem
              icon={<FolderPlusIcon className="size-4" />}
              onClick={() => openDialog(() => setCreateCategoryOpen(true))}
            >
              Создать категорию
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
              {isOwner ? 'Удалить сервер' : 'Покинуть сервер'}
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
              Копировать ID сервера
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
                  ? `Удалить сервер «${serverName}»?`
                  : `Покинуть сервер «${serverName}»?`}
              </DialogTitle>
              <DialogDescription>
                {isOwner
                  ? 'Это действие необратимо. Сервер и его каналы будут удалены.'
                  : 'Вы потеряете доступ к каналам этого сервера.'}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={removingServer}
                onClick={() => setRemoveDialogOpen(false)}
              >
                Отмена
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={removingServer}
                onClick={() => void handleRemoveServer()}
              >
                {isOwner ? 'Удалить сервер' : 'Покинуть сервер'}
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
