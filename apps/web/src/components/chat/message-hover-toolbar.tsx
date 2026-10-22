import { useState } from 'react'
import type { Message } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'
import { ReplyIcon, SmilePlusIcon } from '#/components/icons'

import { MessageActionsMenu } from '#/components/chat/message-actions-menu'
import { MessageReactionPicker } from '#/components/chat/message-reaction-picker'
import { Button } from '@syrnike13/ui/primitives/button'
import { Separator } from '@syrnike13/ui/primitives/separator'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@syrnike13/ui/primitives/tooltip'
import { HOVER_BAR_REACTIONS } from '#/lib/reactions'
import { cn } from '#/lib/utils'

const toolbarButtonClass = 'size-7 shrink-0 p-0 text-base'

const toolbarIconButtonClass = 'size-7 shrink-0'

type MessageHoverToolbarProps = {
  message: Message
  channelId: string
  own: boolean
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
  const t = useTranslations('chat')
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
        'group-hover/message:pointer-events-auto group-hover/message:opacity-100',
        'group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100',
        pinnedOpen && 'pointer-events-auto opacity-100',
      )}
    >
      <div
        className={cn(
          'gradient-surface-floating flex items-center gap-0.5 rounded-md border border-border',
          'bg-popover px-0.5 py-0.5 text-popover-foreground shadow-md',
        )}
        role="toolbar"
        aria-label={t('messageActions')}
      >
        {HOVER_BAR_REACTIONS.map((emoji) => {
          const active = currentUserId
            ? (message.reactions?.[emoji] ?? []).includes(currentUserId)
            : false

          return (
            <Button
              key={emoji}
              type="button"
              variant={active ? 'secondary' : 'ghost'}
              className={toolbarButtonClass}
              aria-label={emoji}
              onClick={() => onToggleReaction(emoji, active)}
            >
              {emoji}
            </Button>
          )
        })}

        <Separator orientation="vertical" className="mx-0.5 h-5" />

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
              aria-label={t('addReaction')}
              title={t('addReaction')}
            >
              <SmilePlusIcon className="size-4" />
            </Button>
          }
        />

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={toolbarIconButtonClass}
                aria-label={t('reply')}
              />
            }
          >
            <ReplyIcon className="size-4" />
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>
            {t('reply')}
          </TooltipContent>
        </Tooltip>

        <MessageActionsMenu
          message={message}
          channelId={channelId}
          own={own}
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
