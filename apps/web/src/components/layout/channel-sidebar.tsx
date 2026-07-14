import { ChannelSidebarItem } from '#/components/channels/channel-sidebar-item'
import { ServerChannelList } from '#/components/channels/server-channel-list'
import { ScrollArea } from '#/components/ui/scroll-area'
import { useAuth } from '#/features/auth/auth-context'
import {
  listVisibleDmRailChannels,
} from '#/features/sync/selectors'
import { USER_PANEL_RESERVE_PX } from '#/components/layout/left-sidebar-stack'
import {
  shellColumnHeaderClass,
  shellNavSurface,
} from '#/components/layout/shell-chrome'
import { cn } from '#/lib/utils'
import { ServerHeaderMenu } from '#/components/servers/server-header-menu'
import { useServerMembersSync } from '#/features/sync/server-members-sync'
import { useSyncStore } from '#/features/sync/sync-store'

type ChannelSidebarProps = {
  activeChannelId?: string
  reserveUserPanelSpace?: boolean
}

export function ChannelSidebar({
  activeChannelId,
  reserveUserPanelSpace = true,
}: ChannelSidebarProps) {
  const auth = useAuth()
  const selectedServerId = useSyncStore((s) => s.selectedServerId)
  const users = useSyncStore((s) => s.users)
  const unreads = useSyncStore((s) => s.unreads)
  const servers = useSyncStore((s) => s.servers)

  const dmChannels = useSyncStore((s) =>
    listVisibleDmRailChannels(s, auth.user?._id),
  )

  useServerMembersSync(selectedServerId, auth.session?.token)

  const serverName = selectedServerId
    ? servers[selectedServerId]?.name
    : 'Личные сообщения'

  return (
    <aside
      className={`flex h-full min-h-0 w-full flex-col ${shellNavSurface}`}
      style={
        reserveUserPanelSpace
          ? { paddingBottom: USER_PANEL_RESERVE_PX }
          : undefined
      }
    >
      <header className={cn(shellColumnHeaderClass, 'bg-transparent px-3')}>
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

      <ScrollArea className="min-h-0 flex-1">
        {selectedServerId ? (
          <ServerChannelList
            serverId={selectedServerId}
            activeChannelId={activeChannelId}
            users={users}
            currentUserId={auth.user?._id}
            unreads={unreads}
          />
        ) : (
          <div className="min-h-[var(--radix-scroll-area-viewport-height,100%)] p-2">
            {dmChannels.length === 0 ? (
              <p className="px-2 py-4 text-xs text-muted-foreground">
                Нет доступных каналов
              </p>
            ) : (
              <nav className="flex flex-col gap-0.5">
                {dmChannels.map((channel) => (
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
          </div>
        )}
      </ScrollArea>
    </aside>
  )
}
