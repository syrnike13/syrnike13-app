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
} from 'lucide-react'
import { toast } from 'sonner'

import { messageDeepLink } from '#/lib/message-link'
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
  open?: boolean
  onOpenChange?: (open: boolean) => void
  triggerClassName?: string
  onReply: () => void
  onEdit?: () => void
  onDelete?: () => void
  onBlock?: () => void
  onPin?: () => void
  onUnpin?: () => void
}

async function copyText(label: string, value: string) {
  try {
    await navigator.clipboard.writeText(value)
    toast.success(label)
  } catch {
    toast.error('Не удалось скопировать')
  }
}

export function MessageActionsMenu({
  message,
  channelId,
  own,
  open,
  onOpenChange,
  triggerClassName,
  onReply,
  onEdit,
  onDelete,
  onBlock,
  onPin,
  onUnpin,
}: MessageActionsMenuProps) {
  const canEdit = own && Boolean(message.content?.trim())
  const pinned = Boolean(message.pinned)
  const hasText = Boolean(message.content?.trim())

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
          onClick={onReply}
        >
          <ReplyIcon className="size-3.5" />
          Ответить
        </Button>
        {hasText ? (
          <Button
            type="button"
            variant="ghost"
            className="h-8 w-full justify-start px-2 font-normal"
            onClick={() => void copyText('Текст скопирован', message.content!)}
          >
            <CopyIcon className="size-3.5" />
            Копировать текст
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          className="h-8 w-full justify-start px-2 font-normal"
          onClick={() => void copyText('ID скопирован', message._id)}
        >
          <CopyIcon className="size-3.5" />
          Копировать ID
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="h-8 w-full justify-start px-2 font-normal"
          onClick={() =>
            void copyText(
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
            onClick={onUnpin}
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
            onClick={onPin}
          >
            <PinIcon className="size-3.5" />
            Закрепить
          </Button>
        ) : null}
        {canEdit && onEdit ? (
          <Button
            type="button"
            variant="ghost"
            className="h-8 w-full justify-start px-2 font-normal"
            onClick={onEdit}
          >
            <PencilIcon className="size-3.5" />
            Изменить
          </Button>
        ) : null}
        {own && onDelete ? (
          <Button
            type="button"
            variant="ghost"
            className="h-8 w-full justify-start px-2 font-normal text-destructive hover:text-destructive"
            onClick={onDelete}
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
            onClick={onBlock}
          >
            <BanIcon className="size-3.5" />
            Заблокировать
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
