import type { Message } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Effect } from 'effect'
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
import { writeClipboardTextEffect } from '#/lib/clipboard'
import { cn } from '#/lib/utils'
import { Button } from '@syrnike13/ui/primitives/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@syrnike13/ui/primitives/popover'

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

async function copyText(label: string, value: string, errorLabel: string) {
  try {
    await Effect.runPromise(writeClipboardTextEffect(value))
    toast.success(label)
  } catch {
    toast.error(errorLabel)
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
  const t = useTranslations('chat')
  const canEdit = own && Boolean(message.content?.trim())
  const pinned = Boolean(message.pinned)
  const hasText = Boolean(message.content?.trim())

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={<Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn('size-7', triggerClassName)}
          title={t('more')} />}>
          <MoreHorizontalIcon className="size-3.5" />
        </PopoverTrigger>
      <PopoverContent className="w-44 p-1" align="end">
        <Button
          type="button"
          variant="ghost"
          className="h-8 w-full justify-start px-2 font-normal"
          onClick={onReply}
        >
          <ReplyIcon className="size-3.5" />
          {t('reply')}
        </Button>
        {hasText ? (
          <Button
            type="button"
            variant="ghost"
            className="h-8 w-full justify-start px-2 font-normal"
            onClick={() =>
              void copyText(t('textCopied'), message.content!, t('copyError'))
            }
          >
            <CopyIcon className="size-3.5" />
            {t('copyText')}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          className="h-8 w-full justify-start px-2 font-normal"
          onClick={() => void copyText(t('idCopied'), message._id, t('copyError'))}
        >
          <CopyIcon className="size-3.5" />
          {t('copyId')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="h-8 w-full justify-start px-2 font-normal"
          onClick={() =>
            void copyText(
              t('linkCopied'),
              messageDeepLink(channelId, message._id),
              t('copyError'),
            )
          }
        >
          <LinkIcon className="size-3.5" />
          {t('copyLink')}
        </Button>
        {pinned && onUnpin ? (
          <Button
            type="button"
            variant="ghost"
            className="h-8 w-full justify-start px-2 font-normal"
            onClick={onUnpin}
          >
            <PinOffIcon className="size-3.5" />
            {t('unpin')}
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
            {t('pin')}
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
            {t('edit')}
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
            {t('delete')}
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
            {t('block')}
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
