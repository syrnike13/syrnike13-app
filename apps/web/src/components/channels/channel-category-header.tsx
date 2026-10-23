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
      className="group/category flex h-10 items-center gap-1 px-2 pt-4"
      data-channel-category=""
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1 text-left"
        onClick={onToggleCollapsed}
      >
        <span className="truncate text-sm font-medium leading-4.5 tracking-tight text-muted-foreground">
          {title}
        </span>
        <ChevronDownIcon
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform',
            collapsed && '-rotate-90',
          )}
        />
      </button>
      {canManage ? (
        <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/category:opacity-100">
          <button
            type="button"
            className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t('createChannel')}
            aria-label={t('createChannel')}
            onClick={() => setCreateChannelOpen(true)}
          >
            <PlusIcon className="size-3.5" />
          </button>
          <button
            type="button"
            className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t('categorySettings')}
            aria-label={t('categorySettings')}
            onClick={() => setSettingsOpen(true)}
          >
            <SettingsIcon className="size-3.5" />
          </button>
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
