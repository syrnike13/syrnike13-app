import type { Message } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Effect } from 'effect'
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
import { toast } from 'sonner'

import { messageDeepLink } from '#/lib/message-link'
import { writeClipboardTextEffect } from '#/lib/clipboard'
import type { ReactNode } from 'react'

export type MessageActionItem = {
  key: string
  label: string
  icon: ReactNode
  destructive?: boolean
  separatorBefore?: boolean
  onSelect: () => void
}

async function copyText(label: string, value: string, errorLabel: string) {
  try {
    await Effect.runPromise(writeClipboardTextEffect(value))
    toast.success(label)
  } catch {
    toast.error(errorLabel)
  }
}

type UseMessageActionsOptions = {
  message: Message
  channelId: string
  own: boolean
  onReply: () => void
  onEdit?: () => void
  onDelete?: () => void
  onBlock?: () => void
  onPin?: () => void
  onUnpin?: () => void
}

/** Один набор действий для hover-меню и контекстного меню. */
export function useMessageActions({
  message,
  channelId,
  own,
  onReply,
  onEdit,
  onDelete,
  onBlock,
  onPin,
  onUnpin,
}: UseMessageActionsOptions): MessageActionItem[] {
  const t = useTranslations('chat')
  const canEdit = own && Boolean(message.content?.trim())
  const hasText = Boolean(message.content?.trim())
  const pinned = Boolean(message.pinned)
  const actions: MessageActionItem[] = [
    {
      key: 'reply',
      label: t('reply'),
      icon: <ReplyIcon className="size-4" />,
      onSelect: onReply,
    },
  ]

  if (hasText) {
    actions.push({
      key: 'copy-text',
      label: t('copyText'),
      icon: <CopyIcon className="size-4" />,
      onSelect: () =>
        void copyText(t('textCopied'), message.content!, t('copyError')),
    })
  }

  actions.push({
    key: 'copy-id',
    label: t('copyId'),
    icon: <CopyIcon className="size-4" />,
    onSelect: () =>
      void copyText(t('idCopied'), message._id, t('copyError')),
  })

  actions.push({
    key: 'copy-link',
    label: t('copyLink'),
    icon: <LinkIcon className="size-4" />,
    onSelect: () =>
      void copyText(
        t('linkCopied'),
        messageDeepLink(channelId, message._id),
        t('copyError'),
      ),
  })

  if (pinned && onUnpin) {
    actions.push({
      key: 'unpin',
      label: t('unpin'),
      icon: <PinOffIcon className="size-4" />,
      separatorBefore: true,
      onSelect: onUnpin,
    })
  } else if (!pinned && onPin) {
    actions.push({
      key: 'pin',
      label: t('pin'),
      icon: <PinIcon className="size-4" />,
      separatorBefore: true,
      onSelect: onPin,
    })
  }

  if (canEdit && onEdit) {
    actions.push({
      key: 'edit',
      label: t('edit'),
      icon: <PencilIcon className="size-4" />,
      separatorBefore: true,
      onSelect: onEdit,
    })
  }

  if (own && onDelete) {
    actions.push({
      key: 'delete',
      label: t('delete'),
      icon: <Trash2Icon className="size-4" />,
      destructive: true,
      separatorBefore: true,
      onSelect: onDelete,
    })
  }

  if (!own && onBlock) {
    actions.push({
      key: 'block',
      label: t('block'),
      icon: <BanIcon className="size-4" />,
      destructive: true,
      separatorBefore: true,
      onSelect: onBlock,
    })
  }

  return actions
}
