import type { ReactElement } from 'react'
import type { Message } from '@syrnike13/api-types'
import {
  BanIcon,
  CopyIcon,
  LinkIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  ReplyIcon,
  Trash2Icon,
} from '#/components/icons'

import { copyMessageActionValue } from '#/components/chat/message-action-copy'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '#/components/ui/context-menu'
import { messageDeepLink } from '#/lib/message-link'

type MessageContextMenuProps = {
  children: ReactElement
  message: Message
  channelId: string
  own: boolean
  canDelete?: boolean
  onReply?: () => void
  onEdit?: () => void
  onDelete?: () => void
  onBlock?: () => void
  onPin?: () => void
  onUnpin?: () => void
  onClearReactions?: () => void
}

export function MessageContextMenu({
  children,
  message,
  channelId,
  own,
  canDelete = own,
  onReply,
  onEdit,
  onDelete,
  onBlock,
  onPin,
  onUnpin,
  onClearReactions,
}: MessageContextMenuProps) {
  const canEdit = own && Boolean(message.content?.trim())
  const pinned = Boolean(message.pinned)
  const hasText = Boolean(message.content?.trim())
  const hasReactions = Object.values(message.reactions ?? {}).some(
    (users) => users.length > 0,
  )
  const showMessageActions = Boolean(
    onReply ||
      (pinned && onUnpin) ||
      (!pinned && onPin) ||
      (hasReactions && onClearReactions) ||
      (canEdit && onEdit) ||
      (canDelete && onDelete) ||
      (!own && onBlock),
  )

  function copy(label: string, value: string) {
    void copyMessageActionValue(label, value)
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        {onReply ? (
          <ContextMenuItem onSelect={onReply}>
            <ReplyIcon className="size-3.5" />
            Ответить
          </ContextMenuItem>
        ) : null}
        {hasText ? (
          <ContextMenuItem
            onSelect={() => copy('Текст скопирован', message.content!)}
          >
            <CopyIcon className="size-3.5" />
            Копировать текст
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem onSelect={() => copy('ID скопирован', message._id)}>
          <CopyIcon className="size-3.5" />
          Копировать ID
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            copy('Ссылка скопирована', messageDeepLink(channelId, message._id))
          }
        >
          <LinkIcon className="size-3.5" />
          Копировать ссылку
        </ContextMenuItem>
        {showMessageActions ? <ContextMenuSeparator /> : null}
        {pinned && onUnpin ? (
          <ContextMenuItem onSelect={onUnpin}>
            <PinOffIcon className="size-3.5" />
            Открепить
          </ContextMenuItem>
        ) : null}
        {!pinned && onPin ? (
          <ContextMenuItem onSelect={onPin}>
            <PinIcon className="size-3.5" />
            Закрепить
          </ContextMenuItem>
        ) : null}
        {hasReactions && onClearReactions ? (
          <ContextMenuItem
            variant="destructive"
            onSelect={onClearReactions}
          >
            <Trash2Icon className="size-3.5" />
            Очистить реакции
          </ContextMenuItem>
        ) : null}
        {canEdit && onEdit ? (
          <ContextMenuItem onSelect={onEdit}>
            <PencilIcon className="size-3.5" />
            Изменить
          </ContextMenuItem>
        ) : null}
        {canDelete && onDelete ? (
          <ContextMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2Icon className="size-3.5" />
            Удалить
          </ContextMenuItem>
        ) : null}
        {!own && onBlock ? (
          <ContextMenuItem variant="destructive" onSelect={onBlock}>
            <BanIcon className="size-3.5" />
            Заблокировать
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
}
