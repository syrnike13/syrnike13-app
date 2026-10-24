import { useTranslations } from '@syrnike13/ui/i18n'
import { ChevronDownIcon, PlusIcon, SettingsIcon } from '#/components/icons'
import { useState } from 'react'

import { CategorySettingsDialog } from '#/components/channels/category-settings-dialog'
import { CreateChannelDialog } from '#/components/servers/create-channel-dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@syrnike13/ui/primitives/context-menu'
import { Button } from '@syrnike13/ui/primitives/button'
import { Collapsible, CollapsibleTrigger } from '@syrnike13/ui/primitives/collapsible'
import { SidebarGroupLabel } from '@syrnike13/ui/primitives/sidebar'
import { cn } from '#/lib/utils'

type ChannelCategoryHeaderProps = {
  serverId: string
  categoryId: string
  title: string
  collapsed: boolean
  canManage: boolean
  onToggleCollapsed: () => void
}

export function ChannelCategoryHeader({
  serverId,
  categoryId,
  title,
  collapsed,
  canManage,
  onToggleCollapsed,
}: ChannelCategoryHeaderProps) {
  const t = useTranslations('channels')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [createChannelOpen, setCreateChannelOpen] = useState(false)

  const header = (
    <div
      className="group/category flex h-10 items-end gap-1 pr-1"
      data-channel-category=""
    >
      <Collapsible
        open={!collapsed}
        onOpenChange={onToggleCollapsed}
        className="flex min-w-0 flex-1"
      >
        <SidebarGroupLabel render={<CollapsibleTrigger />}>
          <span>{title}</span>
          <ChevronDownIcon className={cn('transition-transform', collapsed && '-rotate-90')} />
        </SidebarGroupLabel>
      </Collapsible>
      {canManage ? (
        <div className="flex shrink-0 items-center text-muted-foreground opacity-0 transition-opacity group-hover/category:opacity-100 focus-within:opacity-100">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            title={t('createChannel')}
            aria-label={t('createChannel')}
            onClick={() => setCreateChannelOpen(true)}
          >
            <PlusIcon />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            title={t('categorySettings')}
            aria-label={t('categorySettings')}
            onClick={() => setSettingsOpen(true)}
          >
            <SettingsIcon />
          </Button>
        </div>
      ) : null}
    </div>
  )

  return (
    <>
      {canManage ? (
        <ContextMenu>
          <ContextMenuTrigger render={header} />
          <ContextMenuContent className="w-52">
            <ContextMenuItem onClick={() => setCreateChannelOpen(true)}>
              <PlusIcon />
              {t('createChannel')}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => setSettingsOpen(true)}>
              <SettingsIcon />
              {t('categorySettings')}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        header
      )}

      {canManage ? (
        <>
          <CategorySettingsDialog
            serverId={serverId}
            category={{ id: categoryId, title, channels: [] }}
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
          />
          <CreateChannelDialog
            serverId={serverId}
            categoryId={categoryId}
            open={createChannelOpen}
            onOpenChange={setCreateChannelOpen}
          />
        </>
      ) : null}
    </>
  )
}
