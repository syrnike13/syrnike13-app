import { Link } from '@tanstack/react-router'
import { LightbulbIcon, UsersIcon } from '#/components/icons'

import { CommandPaletteTrigger } from '#/components/command-palette/command-palette-trigger'
import { DmChannelList } from '#/components/home/dm-channel-list'
import { NewConversationButton } from '#/components/home/new-conversation-button'
import { USER_PANEL_RESERVE_PX } from '#/components/layout/left-sidebar-stack'
import { shellDivider, shellNavSurface } from '#/components/layout/shell-chrome'
import { Button } from '#/components/ui/button'
import { ScrollArea } from '#/components/ui/scroll-area'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
type HomeSidebarProps = {
  activeChannelId?: string
  reserveUserPanelSpace?: boolean
  userPanelReservePx?: number
}

const activeNavItemClassName =
  'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 hover:text-primary-foreground' as const

export function HomeSidebar({
  activeChannelId,
  reserveUserPanelSpace = true,
  userPanelReservePx = USER_PANEL_RESERVE_PX,
}: HomeSidebarProps) {
  const prefix = useAppRoutePrefix()
  return (
    <aside
      className={`flex h-full min-h-0 w-full flex-col ${shellNavSurface}`}
      style={
        reserveUserPanelSpace
          ? { paddingBottom: userPanelReservePx }
          : undefined
      }
    >
      <div className={`space-y-2 border-b p-2 ${shellDivider}`}>
        <CommandPaletteTrigger />
        <Button
          variant="ghost"
          className="h-9 w-full justify-start gap-2 px-2 font-medium"
          asChild
        >
          <Link
            to={prefix}
            search={{ tab: 'online' }}
            activeOptions={{ exact: true }}
            activeProps={{ className: activeNavItemClassName }}
          >
            <UsersIcon className="size-4 shrink-0" />
            Друзья
          </Link>
        </Button>
        <Button
          variant="ghost"
          className="h-9 w-full justify-start gap-2 px-2 font-medium"
          asChild
        >
          <Link
            to={`${prefix}/feedback`}
            search={{ view: 'all' }}
            activeProps={{ className: activeNavItemClassName }}
          >
            <LightbulbIcon className="size-4 shrink-0" />
            Идеи
          </Link>
        </Button>
      </div>

      <div className="flex items-center justify-between px-3 py-2">
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Личные сообщения
        </p>
        <NewConversationButton />
      </div>

      <ScrollArea className="min-h-0 flex-1 px-2">
        <DmChannelList activeChannelId={activeChannelId} />
      </ScrollArea>
    </aside>
  )
}
