import { ChevronDownIcon, PlusIcon, SettingsIcon } from 'lucide-react'
import { useState } from 'react'

import { CategorySettingsDialog } from '#/components/channels/category-settings-dialog'
import { CreateChannelDialog } from '#/components/servers/create-channel-dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '#/components/ui/context-menu'
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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [createChannelOpen, setCreateChannelOpen] = useState(false)

  const header = (
    <div
      className="group/category flex items-center gap-0.5 px-1 pt-3 pb-0.5"
      data-channel-category=""
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-0.5 text-left"
        onClick={onToggleCollapsed}
      >
        <ChevronDownIcon
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform',
            collapsed && '-rotate-90',
          )}
        />
        <span className="truncate text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {title}
        </span>
      </button>
      {canManage ? (
        <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/category:opacity-100">
          <button
            type="button"
            className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Создать канал"
            aria-label="Создать канал"
            onClick={() => setCreateChannelOpen(true)}
          >
            <PlusIcon className="size-3.5" />
          </button>
          <button
            type="button"
            className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Настройки категории"
            aria-label="Настройки категории"
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
          <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
          <ContextMenuContent className="w-52">
            <ContextMenuItem onSelect={() => setCreateChannelOpen(true)}>
              <PlusIcon className="size-3.5" />
              Создать канал
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => setSettingsOpen(true)}>
              <SettingsIcon className="size-3.5" />
              Настройки категории
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ) : (
        header
      )}

      <CategorySettingsDialog
        serverId={serverId}
        category={{ id: categoryId, title, channels: [] }}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
      {canManage ? (
        <CreateChannelDialog
          serverId={serverId}
          categoryId={categoryId}
          open={createChannelOpen}
          onOpenChange={setCreateChannelOpen}
        />
      ) : null}
    </>
  )
}
