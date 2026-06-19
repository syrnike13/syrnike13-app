import { useState } from 'react'
import type { Message } from '@syrnike13/api-types'
import { ReplyIcon, SmilePlusIcon } from '#/components/icons'

import { MessageActionsMenu } from '#/components/chat/message-actions-menu'
import { MessageReactionPicker } from '#/components/chat/message-reaction-picker'
import { Button } from '#/components/ui/button'
import { HOVER_BAR_REACTIONS } from '#/lib/reactions'
import { cn } from '#/lib/utils'

const toolbarButtonClass =
  'size-8 shrink-0 rounded-md p-0 text-lg text-muted-foreground hover:bg-muted hover:text-foreground'

const toolbarIconButtonClass =
  'size-8 shrink-0 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground'

type MessageHoverToolbarProps = {
  message: Message
  channelId: string
  own: boolean
  canDelete?: boolean
  compact?: boolean
  currentUserId?: string
  onReply: () => void
  onEdit?: () => void
  onDelete?: () => void
  onBlock?: () => void
  onPin?: () => void
  onUnpin?: () => void
  onToggleReaction: (emoji: string, active: boolean) => void
}

export function MessageHoverToolbar({
  message,
  channelId,
  own,
  canDelete = own,
  compact = false,
  currentUserId,
  onReply,
  onEdit,
  onDelete,
  onBlock,
  onPin,
  onUnpin,
  onToggleReaction,
}: MessageHoverToolbarProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const pinnedOpen = pickerOpen || menuOpen

  function pickReaction(emoji: string) {
    const active = currentUserId
      ? (message.reactions?.[emoji] ?? []).includes(currentUserId)
      : false
    onToggleReaction(emoji, active)
    setPickerOpen(false)
  }

  return (
    <div
      className={cn(
        'pointer-events-none absolute right-0 z-20 opacity-0 transition-opacity',
        compact ? 'top-0' : '-top-3',
        'group-hover:pointer-events-auto group-hover:opacity-100',
        'group-focus-within:pointer-events-auto group-focus-within:opacity-100',
        pinnedOpen && 'pointer-events-auto opacity-100',
      )}
    >
      <div
        className={cn(
          'flex items-center gap-0.5 rounded-lg border border-border',
          'bg-popover px-0.5 py-0.5 text-popover-foreground shadow-md',
        )}
        role="toolbar"
        aria-label="Действия с сообщением"
      >
        {HOVER_BAR_REACTIONS.map((emoji) => {
          const active = currentUserId
            ? (message.reactions?.[emoji] ?? []).includes(currentUserId)
            : false

          return (
            <Button
              key={emoji}
              type="button"
              variant="ghost"
              className={cn(
                toolbarButtonClass,
                active && 'bg-primary/15 ring-1 ring-primary/30',
              )}
              title={emoji}
              onClick={() => onToggleReaction(emoji, active)}
            >
              {emoji}
            </Button>
          )
        })}

        <div className="mx-0.5 h-5 w-px shrink-0 bg-border" aria-hidden />

        <MessageReactionPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onPick={pickReaction}
          align="end"
          trigger={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={toolbarIconButtonClass}
              title="Добавить реакцию"
            >
              <SmilePlusIcon className="size-4" />
            </Button>
          }
        />

        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={toolbarIconButtonClass}
          title="Ответить"
          onClick={onReply}
        >
          <ReplyIcon className="size-4" />
        </Button>

        <MessageActionsMenu
          message={message}
          channelId={channelId}
          own={own}
          canDelete={canDelete}
          open={menuOpen}
          onOpenChange={setMenuOpen}
          onReply={onReply}
          onEdit={onEdit}
          onDelete={onDelete}
          onBlock={onBlock}
          onPin={onPin}
          onUnpin={onUnpin}
          triggerClassName={toolbarIconButtonClass}
        />
      </div>
    </div>
  )
}
