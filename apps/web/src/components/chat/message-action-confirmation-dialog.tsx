import type { Message, User } from '@syrnike13/api-types'

import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'

export type ChatMessageAction =
  | { type: 'delete'; message: Message }
  | { type: 'clearReactions'; message: Message }
  | { type: 'block'; message: Message; user?: User }

type MessageActionConfirmationDialogProps = {
  action: ChatMessageAction | null
  disabled?: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (action: ChatMessageAction) => void
}

export function MessageActionConfirmationDialog({
  action,
  disabled = false,
  onOpenChange,
  onConfirm,
}: MessageActionConfirmationDialogProps) {
  const content = getDialogContent(action)

  return (
    <Dialog open={action != null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{content.title}</DialogTitle>
          <DialogDescription>{content.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() => onOpenChange(false)}
          >
            Отмена
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={disabled || action == null}
            onClick={() => {
              if (action) onConfirm(action)
            }}
          >
            {content.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function getDialogContent(action: ChatMessageAction | null) {
  if (action?.type === 'block') {
    const username = action.user?.username

    return {
      title: username
        ? `Заблокировать @${username}?`
        : 'Заблокировать пользователя?',
      description:
        'Пользователь не сможет писать вам сообщения и отправлять заявки в друзья.',
      confirmLabel: 'Заблокировать',
    }
  }

  if (action?.type === 'clearReactions') {
    return {
      title: 'Очистить реакции?',
      description:
        'Все реакции у сообщения будут удалены. Участники смогут поставить их заново.',
      confirmLabel: 'Очистить',
    }
  }

  return {
    title: 'Удалить сообщение?',
    description: 'Сообщение исчезнет из этого канала. Это действие нельзя отменить.',
    confirmLabel: 'Удалить',
  }
}
