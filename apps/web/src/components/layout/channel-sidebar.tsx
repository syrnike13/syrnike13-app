import { useState } from 'react'
import { CheckCheckIcon } from 'lucide-react'
import { toast } from 'sonner'

import { ChannelSidebarItem } from '#/components/channels/channel-sidebar-item'
import { Button } from '#/components/ui/button'
import { ScrollArea } from '#/components/ui/scroll-area'
import { useAuth } from '#/features/auth/auth-context'
import { ackServer } from '#/features/api/servers-api'
import { syncStore } from '#/features/sync/sync-store'
import {
  EMPTY_CHANNELS,
  listDmChannels,
  listServerChannels,
} from '#/features/sync/selectors'
import { USER_PANEL_RESERVE_PX } from '#/components/layout/left-sidebar-stack'
import { shellDivider, shellNavSurface } from '#/components/layout/shell-chrome'
import { CommandPaletteTrigger } from '#/components/command-palette/command-palette-trigger'
import { CreateChannelDialog } from '#/components/servers/create-channel-dialog'
import { ServerInviteDialog } from '#/components/servers/server-invite-dialog'
import { ServerMenuDialog } from '#/components/servers/server-menu-dialog'
import { useSyncStore } from '#/features/sync/sync-store'
type ChannelSidebarProps = {
  activeChannelId?: string
}

export function ChannelSidebar({ activeChannelId }: ChannelSidebarProps) {
  const auth = useAuth()
  const ready = useSyncStore((s) => s.ready)
  const selectedServerId = useSyncStore((s) => s.selectedServerId)
  const users = useSyncStore((s) => s.users)
  const unreads = useSyncStore((s) => s.unreads)
  const servers = useSyncStore((s) => s.servers)

  const dmChannels = useSyncStore((s) =>
    listDmChannels(s, auth.user?._id),
  )
  const serverChannels = useSyncStore((s) =>
    selectedServerId
      ? listServerChannels(s, selectedServerId)
      : EMPTY_CHANNELS,
  )

  const serverName = selectedServerId
    ? servers[selectedServerId]?.name
    : 'Личные сообщения'

  const channels = selectedServerId ? serverChannels : dmChannels
  const [markingRead, setMarkingRead] = useState(false)

  async function markServerRead() {
    const token = auth.session?.token
    if (!token || !selectedServerId) return
    setMarkingRead(true)
    try {
      await ackServer(token, selectedServerId)
      syncStore.markServerChannelsRead(selectedServerId)
      toast.success('Все каналы отмечены прочитанными')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось отметить',
      )
    } finally {
      setMarkingRead(false)
    }
  }

  return (
    <aside
      className={`flex h-full min-h-0 w-full flex-col ${shellNavSurface}`}
      style={{ paddingBottom: USER_PANEL_RESERVE_PX }}
    >
      <div className={`space-y-2 border-b p-2 ${shellDivider}`}>
        <CommandPaletteTrigger />
        <div className="flex min-w-0 items-center gap-1 px-1">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold leading-5">
            {serverName}
          </h2>
          {selectedServerId ? (
            <div className="flex shrink-0 items-center">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 shrink-0"
                title="Отметить сервер прочитанным"
                disabled={markingRead}
                onClick={() => void markServerRead()}
              >
                <CheckCheckIcon className="size-4" />
                <span className="sr-only">Прочитано</span>
              </Button>
              <CreateChannelDialog serverId={selectedServerId} />
              <ServerInviteDialog serverId={selectedServerId} />
              <ServerMenuDialog
                serverId={selectedServerId}
                serverName={serverName ?? 'Сервер'}
              />
            </div>
          ) : null}
        </div>
        <p className="mt-0.5 truncate px-1 text-xs text-muted-foreground">
          {ready ? `${channels.length} каналов` : 'Синхронизация…'}
        </p>
      </div>

      <ScrollArea className="flex-1 p-2">
        {channels.length === 0 ? (
          <p className="px-2 py-4 text-xs text-muted-foreground">
            Нет доступных каналов
          </p>
        ) : (
          <nav className="flex flex-col gap-0.5">
            {channels.map((channel) => (
              <ChannelSidebarItem
                key={channel._id}
                channel={channel}
                activeChannelId={activeChannelId}
                users={users}
                currentUserId={auth.user?._id}
                unreads={unreads}
              />
            ))}
          </nav>
        )}
      </ScrollArea>
    </aside>
  )
}
