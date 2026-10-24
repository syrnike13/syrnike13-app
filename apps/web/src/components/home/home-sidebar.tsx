import { Link } from '@tanstack/react-router'
import { useTranslations } from '@syrnike13/ui/i18n'
import { LightbulbIcon, UsersIcon } from '#/components/icons'

import { CommandPaletteTrigger } from '#/components/command-palette/command-palette-trigger'
import { DmChannelList } from '#/components/home/dm-channel-list'
import { NewConversationButton } from '#/components/home/new-conversation-button'
import { USER_PANEL_RESERVE_PX } from '#/components/layout/left-sidebar-stack'
import { shellDivider, shellNavSurface } from '#/components/layout/shell-chrome'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@syrnike13/ui/primitives/sidebar'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'
type HomeSidebarProps = {
  activeChannelId?: string
  reserveUserPanelSpace?: boolean
  userPanelReservePx?: number
}

export function HomeSidebar({
  activeChannelId,
  reserveUserPanelSpace = true,
  userPanelReservePx = USER_PANEL_RESERVE_PX,
}: HomeSidebarProps) {
  const tFriends = useTranslations('home.friends')
  const tFeedback = useTranslations('feedback.view')
  const tSidebar = useTranslations('home.sidebar')
  const prefix = useAppRoutePrefix()
  return (
    <aside
      className={cn(
        'flex h-full min-h-0 w-full flex-col',
        shellNavSurface,
        reserveUserPanelSpace && 'pb-(--sidebar-bottom-reserve)',
      )}
      style={
        reserveUserPanelSpace
          ? ({
              '--sidebar-bottom-reserve': `${userPanelReservePx}px`,
            } as CSSVars)
          : undefined
      }
    >
      <div className={`flex flex-col gap-2 border-b p-2 ${shellDivider}`}>
        <CommandPaletteTrigger />
        <nav aria-label={tSidebar('navigation')}>
          <SidebarMenu className="gap-0.5">
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                render={
                  <Link
                    to={prefix || '/'}
                    search={{ tab: 'online' }}
                    activeOptions={{ exact: true }}
                    activeProps={{ 'data-active': '' }}
                  />
                }
              >
                <UsersIcon />
                <span>{tFriends('title')}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                render={
                  <Link
                    to={`${prefix}/feedback`}
                    search={{ view: 'all' }}
                    activeProps={{ 'data-active': '' }}
                  />
                }
              >
                <LightbulbIcon />
                <span>{tFeedback('title')}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </nav>
      </div>

      <div className="flex items-center justify-between px-3 py-2">
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {tSidebar('directMessages')}
        </h2>
        <NewConversationButton />
      </div>

      <ScrollArea className="min-h-0 flex-1 px-2">
        <DmChannelList activeChannelId={activeChannelId} />
      </ScrollArea>
    </aside>
  )
}
