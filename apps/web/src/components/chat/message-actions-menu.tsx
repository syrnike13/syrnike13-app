import { Fragment } from 'react'
import type { Message } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'
import { MoreHorizontalIcon } from '#/components/icons'

import { useMessageActions } from '#/components/chat/message-actions'
import { Button } from '@syrnike13/ui/primitives/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@syrnike13/ui/primitives/dropdown-menu'
import { cn } from '#/lib/utils'

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
  const actions = useMessageActions({
    message,
    channelId,
    own,
    onReply,
    onEdit,
    onDelete,
    onBlock,
    onPin,
    onUnpin,
  })

  return (
    <DropdownMenu open={open} onOpenChange={(next) => onOpenChange?.(next)}>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              'size-7',
              // eslint-disable-next-line shadcn/require-static-classes -- caller-owned trigger styling
              triggerClassName,
            )}
            aria-label={t('more')}
          />
        }
      >
        <MoreHorizontalIcon className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-52" align="end" sideOffset={6}>
        {actions.map((action) => (
          <Fragment key={action.key}>
            {action.separatorBefore ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              variant={action.destructive ? 'destructive' : 'default'}
              onClick={action.onSelect}
            >
              {action.icon}
              {action.label}
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
