import { useQuery } from '@tanstack/react-query'
import { PinIcon } from '#/components/icons'
import { useTranslations } from '@syrnike13/ui/i18n'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import type { User } from '@syrnike13/api-types'
import { Effect } from 'effect'
import { toast } from 'sonner'

import { Button } from '@syrnike13/ui/primitives/button'
import { Empty, EmptyDescription } from '@syrnike13/ui/primitives/empty'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
} from '@syrnike13/ui/primitives/item'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@syrnike13/ui/primitives/dialog'
import { fetchPinnedMessagesEffect } from '#/features/api/messages-api'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { renderMessageContent } from '#/lib/message-markdown'
import { queryKeys } from '#/lib/api/query-keys'
import { apiErrorMessage } from '#/lib/api/error-message'
import { writeClipboardTextEffect } from '#/lib/clipboard'
import { serverChannelServerId } from '#/lib/channel-voice'

type ChannelPinnedDialogProps = {
  channelId: string
  token: string
  users: Record<string, User>
  /** `media` on the voice stage header. */
  triggerVariant?: 'ghost' | 'media'
}

export function ChannelPinnedDialog({
  channelId,
  token,
  users,
  triggerVariant = 'ghost',
}: ChannelPinnedDialogProps) {
  const t = useTranslations('chat')
  const navigate = useNavigate()
  const prefix = useAppRoutePrefix()
  const emojis = useSyncStore((s) => s.emojis)
  const channels = useSyncStore((s) => s.channels)
  const serverId = serverChannelServerId(channels[channelId])
  const server = useSyncStore((s) =>
    serverId ? s.servers[serverId] : undefined,
  )
  const [open, setOpen] = useState(false)

  const pinnedQuery = useQuery({
    queryKey: queryKeys.channels.pinned(channelId),
    queryFn: async ({ signal }) => {
      const { messages, users: foundUsers } = await Effect.runPromise(
        fetchPinnedMessagesEffect(token, channelId, 50),
        { signal },
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
      <DialogTrigger
        render={
          <Button
            type="button"
            variant={triggerVariant}
            size="icon"
            title={t('pinnedTitle')}
            aria-label={t('pinnedTitle')}
          />
        }
      >
        <PinIcon className="size-5" />
      </DialogTrigger>
      <DialogContent className="flex max-h-dialog-xs max-w-lg flex-col gap-4">
        <DialogHeader>
          <DialogTitle>{t('pinnedTitle')}</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {pinnedQuery.isFetching ? (
            <Spinner className="mx-auto" />
          ) : null}
          {pinnedQuery.isError ? (
            <p className="text-sm text-destructive">
              {apiErrorMessage(pinnedQuery.error, t('loadError'))}
            </p>
          ) : null}
          {!pinnedQuery.isFetching &&
          !pinnedQuery.isError &&
          messages.length === 0 ? (
            <Empty>
              <EmptyDescription>{t('noPinned')}</EmptyDescription>
            </Empty>
          ) : null}
          {messages.map((message) => {
            const author = message.user ?? users[message.author]
            const name =
              author?.display_name ?? author?.username ?? t('unknownAuthor')

            return (
              <Item key={message._id} variant="outline" render={<article />}>
                <ItemContent>
                  <ItemDescription>{name}</ItemDescription>
                  {message.content ? (
                    <div className="select-text">
                      {renderMessageContent(message.content, users, emojis, {
                        channels,
                        roles: server?.roles,
                      })}
                    </div>
                  ) : (
                    <p className="text-muted-foreground italic">{t('noText')}</p>
                  )}
                </ItemContent>
                <ItemActions>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      Effect.runFork(
                        writeClipboardTextEffect(message._id).pipe(
                          Effect.matchEffect({
                            onFailure: () =>
                              Effect.sync(() => {
                                toast.error(t('copyError'))
                              }),
                            onSuccess: () =>
                              Effect.sync(() => {
                                toast.success(t('idCopied'))
                              }),
                          }),
                        ),
                      )
                    }}
                  >
                    {t('copyId')}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setOpen(false)
                      void navigate({
                        to: `${prefix}/c/$channelId`,
                        params: { channelId },
                        search: { m: message._id },
                      })
                    }}
                  >
                    {t('jump')}
                  </Button>
                </ItemActions>
              </Item>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
