import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import type { Message, User } from '@syrnike13/api-types'
import { SearchIcon } from 'lucide-react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'

import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { searchChannelMessages } from '#/features/api/messages-api'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { renderMessageContent } from '#/lib/message-markdown'

type ChannelSearchDialogProps = {
  channelId: string
  token: string
  users: Record<string, User>
}

export function ChannelSearchDialog({
  channelId,
  token,
  users,
}: ChannelSearchDialogProps) {
  const navigate = useNavigate()
  const emojis = useSyncStore((s) => s.emojis)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Message[]>([])

  const searchMutation = useMutation({
    mutationFn: async (searchQuery: string) => {
      const { messages, users: foundUsers } = await searchChannelMessages(
        token,
        channelId,
        searchQuery,
      )
      return { messages, foundUsers }
    },
    onSuccess: ({ messages, foundUsers }) => {
      setResults(messages)
      for (const user of foundUsers) {
        syncStore.upsertUser(user)
      }
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : 'Поиск не удался',
      )
    },
  })

  function runSearch() {
    const trimmed = query.trim()
    if (!trimmed) return
    searchMutation.mutate(trimmed)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="size-8">
          <SearchIcon className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[80vh] max-w-lg flex-col gap-4">
        <DialogHeader>
          <DialogTitle>Поиск по каналу</DialogTitle>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            runSearch()
          }}
        >
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Текст сообщения…"
            autoFocus
          />
          <Button type="submit" disabled={searchMutation.isPending}>
            Найти
          </Button>
        </form>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {searchMutation.isPending ? (
            <p className="text-sm text-muted-foreground">Ищем…</p>
          ) : null}
          {!searchMutation.isPending && results.length === 0 && query ? (
            <p className="text-sm text-muted-foreground">Ничего не найдено</p>
          ) : null}
          {results.map((message) => {
            const author =
              message.user ??
              users[message.author]
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
                    to: '/app/c/$channelId',
                    params: { channelId },
                    search: { m: message._id },
                  })
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setOpen(false)
                    void navigate({
                      to: '/app/c/$channelId',
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
              </article>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
