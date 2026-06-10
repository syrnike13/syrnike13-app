import { Link } from '@tanstack/react-router'
import { UsersIcon } from '#/components/icons'

import { CommandPaletteTrigger } from '#/components/command-palette/command-palette-trigger'
import { DmChannelList } from '#/components/home/dm-channel-list'
import { NewConversationButton } from '#/components/home/new-conversation-button'
import { USER_PANEL_RESERVE_PX } from '#/components/layout/left-sidebar-stack'
import { shellDivider, shellNavSurface } from '#/components/layout/shell-chrome'
import { Button } from '#/components/ui/button'
import { ScrollArea } from '#/components/ui/scroll-area'
type HomeSidebarProps = {
  activeChannelId?: string
}

export function HomeSidebar({ activeChannelId }: HomeSidebarProps) {
  return (
    <aside
      className={`flex h-full min-h-0 w-full flex-col ${shellNavSurface}`}
      style={{ paddingBottom: USER_PANEL_RESERVE_PX }}
    >
      <div className={`space-y-2 border-b p-2 ${shellDivider}`}>
        <CommandPaletteTrigger />
        <Button
          variant="secondary"
          className="h-9 w-full justify-start gap-2 px-2 font-medium"
          asChild
        >
          <Link to="/app" search={{ tab: 'online' }}>
            <UsersIcon className="size-4 shrink-0" />
            Друзья
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
