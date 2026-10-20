import { Link } from '@tanstack/react-router'
import { useTranslations } from '@syrnike13/ui/i18n'
import { LightbulbIcon, UsersIcon } from '#/components/icons'

import { CommandPaletteTrigger } from '#/components/command-palette/command-palette-trigger'
import { DmChannelList } from '#/components/home/dm-channel-list'
import { NewConversationButton } from '#/components/home/new-conversation-button'
import { USER_PANEL_RESERVE_PX } from '#/components/layout/left-sidebar-stack'
import { shellDivider, shellNavSurface } from '#/components/layout/shell-chrome'
import { buttonVariants } from '@syrnike13/ui/primitives/button'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'
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
  const tFriends = useTranslations('home.friends')
  const tFeedback = useTranslations('feedback.view')
  const prefix = useAppRoutePrefix()
  const navLinkClass = (className: string) =>
    cn(buttonVariants({ variant: 'ghost' }), className)
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
      <div className={`space-y-2 border-b p-2 ${shellDivider}`}>
        <CommandPaletteTrigger />
        <Link
          to={prefix || '/'}
          search={{ tab: 'online' }}
          activeOptions={{ exact: true }}
          activeProps={{ className: activeNavItemClassName }}
          className={navLinkClass(
            'h-9 w-full justify-start gap-2 px-2 font-medium',
          )}
        >
          <UsersIcon className="size-4 shrink-0" />
          {tFriends('title')}
        </Link>
        <Link
          to={`${prefix}/feedback`}
          search={{ view: 'all' }}
          activeProps={{ className: activeNavItemClassName }}
          className={navLinkClass(
            'h-9 w-full justify-start gap-2 px-2 font-medium',
          )}
        >
          <LightbulbIcon className="size-4 shrink-0" />
          {tFeedback('title')}
        </Link>
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
