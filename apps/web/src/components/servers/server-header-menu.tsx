import { useState, type ReactNode } from 'react'
import {
  ChevronDownIcon,
  CopyIcon,
  LogOutIcon,
  PlusCircleIcon,
  SettingsIcon,
  UserPlusIcon,
} from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

import { CreateChannelDialog } from '#/components/servers/create-channel-dialog'
import { ServerInviteDialog } from '#/components/servers/server-invite-dialog'
import { ServerMenuDialog } from '#/components/servers/server-menu-dialog'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { Separator } from '#/components/ui/separator'
import { useAuth } from '#/features/auth/auth-context'
import { leaveServer } from '#/features/api/servers-api'
import { listServerChannels } from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
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
  const server = useSyncStore((s) => s.servers[serverId])
  const member = useSyncStore((s) => s.members[`${serverId}:${auth.user?._id}`])
  const channels = useSyncStore((s) => listServerChannels(s, serverId))
  const menuPermissions = server
    ? getServerMenuPermissions(server, channels, member, auth.user?._id)
    : null
  const [menuOpen, setMenuOpen] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [createChannelOpen, setCreateChannelOpen] = useState(false)
  const [leaving, setLeaving] = useState(false)

  function openDialog(action: () => void) {
    setMenuOpen(false)
    action()
  }

  async function handleLeave() {
    const token = auth.session?.token
    if (!token) return
    if (
      !window.confirm(
        `Покинуть сервер «${serverName}»? Вы потеряете доступ к его каналам.`,
      )
    ) {
      return
    }

    setMenuOpen(false)
    setLeaving(true)
    try {
      await leaveServer(token, serverId)
      syncStore.removeServer(serverId)
      syncStore.setSelectedServerId(null)
      toast.success('Вы покинули сервер')
      await navigate({ to: '/app', search: { tab: 'online' } })
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось покинуть сервер',
      )
    } finally {
      setLeaving(false)
    }
  }

  const showAdminSection = Boolean(
    menuPermissions?.invite ||
      menuPermissions?.settings ||
      menuPermissions?.createChannel,
  )

  async function copyServerId() {
    try {
      await navigator.clipboard.writeText(serverId)
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
              onClick={() => openDialog(() => setSettingsOpen(true))}
            >
              Настройки сервера
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
          {showAdminSection &&
          (menuPermissions?.leave || menuPermissions?.copyId) ? (
            <Separator className="my-1" />
          ) : null}
          {menuPermissions?.leave ? (
            <ServerHeaderMenuItem
              icon={<LogOutIcon className="size-4" />}
              destructive
              disabled={leaving}
              onClick={() => void handleLeave()}
            >
              Покинуть сервер
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

      {menuPermissions?.invite ? (
        <ServerInviteDialog
          serverId={serverId}
          open={inviteOpen}
          onOpenChange={setInviteOpen}
        />
      ) : null}
      {menuPermissions?.settings ? (
        <ServerMenuDialog
          serverId={serverId}
          serverName={serverName}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
        />
      ) : null}
      {menuPermissions?.createChannel ? (
        <CreateChannelDialog
          serverId={serverId}
          open={createChannelOpen}
          onOpenChange={setCreateChannelOpen}
        />
      ) : null}
    </>
  )
}
