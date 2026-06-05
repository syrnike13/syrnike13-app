import { ChannelSidebarItem } from '#/components/channels/channel-sidebar-item'
import { ScrollArea } from '#/components/ui/scroll-area'
import { useAuth } from '#/features/auth/auth-context'
import {
  EMPTY_CHANNELS,
  listDmChannels,
  listServerChannels,
} from '#/features/sync/selectors'
import { USER_PANEL_RESERVE_PX } from '#/components/layout/left-sidebar-stack'
import {
  shellColumnHeaderClass,
  shellNavSurface,
} from '#/components/layout/shell-chrome'
import { cn } from '#/lib/utils'
import { ServerHeaderMenu } from '#/components/servers/server-header-menu'
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

  return (
    <aside
      className={`flex h-full min-h-0 w-full flex-col ${shellNavSurface}`}
      style={{ paddingBottom: USER_PANEL_RESERVE_PX }}
    >
      <header className={cn(shellColumnHeaderClass, 'bg-background px-3')}>
        {selectedServerId ? (
          <ServerHeaderMenu
            serverId={selectedServerId}
            serverName={serverName ?? 'Сервер'}
          />
        ) : (
          <h2 className="min-w-0 flex-1 truncate px-1 text-sm font-semibold">
            {serverName}
          </h2>
        )}
      </header>

      <ScrollArea className="flex-1 p-2">
        <p className="mb-1 truncate px-1 text-xs text-muted-foreground">
          {ready ? `${channels.length} каналов` : 'Синхронизация…'}
        </p>
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
