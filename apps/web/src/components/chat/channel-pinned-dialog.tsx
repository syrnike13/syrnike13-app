import { useQuery } from '@tanstack/react-query'
import { PinIcon } from '#/components/icons'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import type { User } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '#/components/ui/dialog'
import { fetchPinnedMessages } from '#/features/api/messages-api'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { renderMessageContent } from '#/lib/message-markdown'
import { queryKeys } from '#/lib/api/query-keys'
import { writeClipboardText } from '#/lib/clipboard'
import { cn } from '#/lib/utils'

type ChannelPinnedDialogProps = {
  channelId: string
  token: string
  users: Record<string, User>
  triggerClassName?: string
}

export function ChannelPinnedDialog({
  channelId,
  token,
  users,
  triggerClassName,
}: ChannelPinnedDialogProps) {
  const navigate = useNavigate()
  const prefix = useAppRoutePrefix()
  const emojis = useSyncStore((s) => s.emojis)
  const [open, setOpen] = useState(false)

  const pinnedQuery = useQuery({
    queryKey: queryKeys.channels.pinned(channelId),
    queryFn: async () => {
      const { messages, users: foundUsers } = await fetchPinnedMessages(
        token,
        channelId,
      )
      for (const user of foundUsers) {
        syncStore.upsertUser(user)
      }
      for (const message of messages) {
        if (message.user) {
          syncStore.upsertUser(message.user)
        }
        syncStore.upsertMessage(message)
      }
      return messages
    },
    enabled: open,
    staleTime: 15_000,
  })

  const messages = pinnedQuery.data ?? []

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn('size-8', triggerClassName)}
          title="Закреплённые сообщения"
        >
          <PinIcon className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[80vh] max-w-lg flex-col gap-4">
        <DialogHeader>
          <DialogTitle>Закреплённые сообщения</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {pinnedQuery.isFetching ? (
            <p className="text-sm text-muted-foreground">Загрузка…</p>
          ) : null}
          {pinnedQuery.isError ? (
            <p className="text-sm text-destructive">
              {pinnedQuery.error instanceof Error
                ? pinnedQuery.error.message
                : 'Не удалось загрузить'}
            </p>
          ) : null}
          {!pinnedQuery.isFetching &&
          !pinnedQuery.isError &&
          messages.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Нет закреплённых сообщений
            </p>
          ) : null}
          {messages.map((message) => {
            const author = message.user ?? users[message.author]
            const name =
              author?.display_name ?? author?.username ?? 'Неизвестный'

            return (
              <article
                key={message._id}
                role="button"
                tabIndex={0}
                className="cursor-pointer rounded-lg border bg-muted/40 p-3 text-sm transition-colors hover:bg-muted/70"
                onClick={() => {
                  setOpen(false)
                  void navigate({
                    to: `${prefix}/c/$channelId`,
                    params: { channelId },
                    search: { m: message._id },
                  })
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setOpen(false)
                    void navigate({
                      to: `${prefix}/c/$channelId`,
                      params: { channelId },
                      search: { m: message._id },
                    })
                  }
                }}
              >
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  {name}
                </p>
                {message.content ? (
                  <div>
                    {renderMessageContent(message.content, users, emojis)}
                  </div>
                ) : (
                  <p className="text-muted-foreground italic">[без текста]</p>
                )}
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="mt-2 h-auto px-0"
                  onClick={() => {
                    void writeClipboardText(message._id)
                      .then(() => toast.success('ID скопирован'))
                      .catch(() => toast.error('Не удалось скопировать'))
                  }}
                >
                  Копировать ID
                </Button>
              </article>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
