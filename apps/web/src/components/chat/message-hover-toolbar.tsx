import { useState } from 'react'
import type { Message } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'
import { ReplyIcon, SmilePlusIcon } from '#/components/icons'

import { EmojiPicker } from '#/components/emoji/emoji-picker'
import { MessageActionsMenu } from '#/components/chat/message-actions-menu'
import { Button } from '@syrnike13/ui/primitives/button'
import { MessageToolbar } from '@syrnike13/ui/primitives/message'
import { Separator } from '@syrnike13/ui/primitives/separator'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@syrnike13/ui/primitives/tooltip'
import { HOVER_BAR_REACTIONS } from '#/lib/reactions'

type MessageHoverToolbarProps = {
  message: Message
  channelId: string
  own: boolean
  serverId?: string
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
  serverId,
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

  const reacted = (emoji: string) =>
    currentUserId
      ? (message.reactions?.[emoji] ?? []).includes(currentUserId)
      : false

  return (
    <MessageToolbar
      open={pickerOpen || menuOpen}
      aria-label={t('messageActions')}
    >
      {HOVER_BAR_REACTIONS.map((emoji) => (
        <Button
          key={emoji}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={emoji}
          aria-pressed={reacted(emoji)}
          onClick={() => onToggleReaction(emoji, reacted(emoji))}
        >
          <span className="text-base leading-none">{emoji}</span>
        </Button>
      ))}

      <Separator orientation="vertical" className="mx-0.5 h-4 self-center" />

      <EmojiPicker
        serverId={serverId}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={(emoji) => {
          onToggleReaction(emoji, reacted(emoji))
          setPickerOpen(false)
        }}
        trigger={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('addReaction')}
            title={t('addReaction')}
          >
            <SmilePlusIcon className="size-4.5" />
          </Button>
        }
      />

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('reply')}
              onClick={onReply}
            />
          }
        >
          <ReplyIcon className="size-4.5" />
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
      />
    </MessageToolbar>
  )
}
