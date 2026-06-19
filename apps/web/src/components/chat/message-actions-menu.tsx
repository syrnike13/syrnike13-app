import type { Message } from '@syrnike13/api-types'
import {
  BanIcon,
  CopyIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  ReplyIcon,
  Trash2Icon,
} from '#/components/icons'
import { toast } from 'sonner'

import { messageDeepLink } from '#/lib/message-link'
import { writeClipboardText } from '#/lib/clipboard'
import { cn } from '#/lib/utils'
import { Button } from '#/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'

type MessageActionsMenuProps = {
  message: Message
  channelId: string
  own: boolean
  canDelete?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  triggerClassName?: string
  onReply: () => void
  onEdit?: () => void
  onDelete?: () => void
  onBlock?: () => void
  onPin?: () => void
  onUnpin?: () => void
  onClearReactions?: () => void
}

async function copyText(label: string, value: string) {
  try {
    await writeClipboardText(value)
    toast.success(label)
  } catch {
    toast.error('Не удалось скопировать')
  }
}

export function MessageActionsMenu({
  message,
  channelId,
  own,
  canDelete = own,
  open,
  onOpenChange,
  triggerClassName,
  onReply,
  onEdit,
  onDelete,
  onBlock,
  onPin,
  onUnpin,
  onClearReactions,
}: MessageActionsMenuProps) {
  const canEdit = own && Boolean(message.content?.trim())
  const pinned = Boolean(message.pinned)
  const hasText = Boolean(message.content?.trim())
  const hasReactions = Object.values(message.reactions ?? {}).some(
    (users) => users.length > 0,
  )

  function runAction(action: () => void) {
    action()
    onOpenChange?.(false)
  }

  function copyAndClose(label: string, value: string) {
    void copyText(label, value)
    onOpenChange?.(false)
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn('size-7', triggerClassName)}
          title="Ещё"
        >
          <MoreHorizontalIcon className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-44 p-1" align="end">
        <Button
          type="button"
          variant="ghost"
          className="h-8 w-full justify-start px-2 font-normal"
          onClick={() => runAction(onReply)}
        >
          <ReplyIcon className="size-3.5" />
          Ответить
        </Button>
        {hasText ? (
          <Button
            type="button"
            variant="ghost"
            className="h-8 w-full justify-start px-2 font-normal"
            onClick={() => copyAndClose('Текст скопирован', message.content!)}
          >
            <CopyIcon className="size-3.5" />
            Копировать текст
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          className="h-8 w-full justify-start px-2 font-normal"
          onClick={() => copyAndClose('ID скопирован', message._id)}
        >
          <CopyIcon className="size-3.5" />
          Копировать ID
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="h-8 w-full justify-start px-2 font-normal"
          onClick={() =>
            copyAndClose(
              'Ссылка скопирована',
              messageDeepLink(channelId, message._id),
            )
          }
        >
          <LinkIcon className="size-3.5" />
          Копировать ссылку
        </Button>
        {pinned && onUnpin ? (
          <Button
            type="button"
            variant="ghost"
            className="h-8 w-full justify-start px-2 font-normal"
            onClick={() => runAction(onUnpin)}
          >
            <PinOffIcon className="size-3.5" />
            Открепить
          </Button>
        ) : null}
        {!pinned && onPin ? (
          <Button
            type="button"
            variant="ghost"
            className="h-8 w-full justify-start px-2 font-normal"
            onClick={() => runAction(onPin)}
          >
            <PinIcon className="size-3.5" />
            Закрепить
          </Button>
        ) : null}
        {hasReactions && onClearReactions ? (
          <Button
            type="button"
            variant="ghost"
            className="h-8 w-full justify-start px-2 font-normal text-destructive hover:text-destructive"
            onClick={() => runAction(onClearReactions)}
          >
            <Trash2Icon className="size-3.5" />
            Очистить реакции
          </Button>
        ) : null}
        {canEdit && onEdit ? (
          <Button
            type="button"
            variant="ghost"
            className="h-8 w-full justify-start px-2 font-normal"
            onClick={() => runAction(onEdit)}
          >
            <PencilIcon className="size-3.5" />
            Изменить
          </Button>
        ) : null}
        {canDelete && onDelete ? (
          <Button
            type="button"
            variant="ghost"
            className="h-8 w-full justify-start px-2 font-normal text-destructive hover:text-destructive"
            onClick={() => runAction(onDelete)}
          >
            <Trash2Icon className="size-3.5" />
            Удалить
          </Button>
        ) : null}
        {!own && onBlock ? (
          <Button
            type="button"
            variant="ghost"
            className="h-8 w-full justify-start px-2 font-normal text-destructive hover:text-destructive"
            onClick={() => runAction(onBlock)}
          >
            <BanIcon className="size-3.5" />
            Заблокировать
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
