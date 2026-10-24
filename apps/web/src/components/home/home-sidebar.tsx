import { Link } from '@tanstack/react-router'
import { useId } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'
import { LightbulbIcon, UsersIcon } from '#/components/icons'

import { CommandPaletteTrigger } from '#/components/command-palette/command-palette-trigger'
import { DmChannelList } from '#/components/home/dm-channel-list'
import { NewConversationButton } from '#/components/home/new-conversation-button'
import { USER_PANEL_RESERVE_PX } from '#/components/layout/left-sidebar-stack'
import {
  shellColumnHeaderClass,
  shellNavSurface,
} from '#/components/layout/shell-chrome'
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
  const dmHeadingId = useId()
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
      <header className={cn(shellColumnHeaderClass, 'px-2')}>
        <CommandPaletteTrigger />
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <nav aria-label={tSidebar('navigation')} className="p-2">
          <SidebarMenu className="gap-0.5">
            <SidebarMenuItem>
              <SidebarMenuButton
                size="lg"
                render={
                  <Link
                    to={prefix || '/'}
                    search={{ tab: 'online' }}
                    activeOptions={{ exact: true, includeSearch: false }}
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

        <section aria-labelledby={dmHeadingId} className="px-2 pb-2">
          <div className="flex items-center justify-between pt-2 pr-1 pb-1 pl-2">
            <h2 id={dmHeadingId} className="text-sm font-medium text-muted-foreground">
              {tSidebar('directMessages')}
            </h2>
            <NewConversationButton />
          </div>
          <DmChannelList activeChannelId={activeChannelId} />
        </section>
      </ScrollArea>
    </aside>
  )
}
