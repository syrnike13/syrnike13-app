import { useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { Message, User } from '@syrnike13/api-types'
import { SearchIcon } from '#/components/icons'
import { toast } from 'sonner'

import { Input } from '#/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { ScrollArea } from '#/components/ui/scroll-area'
import { searchChannelMessages } from '#/features/api/messages-api'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { renderMessageContent } from '#/lib/message-markdown'
import { cn } from '#/lib/utils'

type ChannelSearchDialogProps = {
  channelId: string
  token: string
  users: Record<string, User>
  variant?: 'strip' | 'icon'
  triggerClassName?: string
  stripClassName?: string
}

export function ChannelSearchDialog({
  channelId,
  token,
  users,
  variant = 'icon',
  triggerClassName,
  stripClassName,
}: ChannelSearchDialogProps) {
  const navigate = useNavigate()
  const prefix = useAppRoutePrefix()
  const emojis = useSyncStore((s) => s.emojis)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Message[]>([])
  const [searching, setSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) {
      setQuery('')
      setResults([])
      setSearching(false)
      return
    }

    const timer = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    const trimmed = query.trim()
    if (!open || trimmed.length < 2) {
      setResults([])
      setSearching(false)
      return
    }

    let cancelled = false
    const timer = window.setTimeout(() => {
      setSearching(true)
      void searchChannelMessages(token, channelId, trimmed)
        .then(({ messages, users: foundUsers }) => {
          if (cancelled) return
          for (const user of foundUsers) {
            syncStore.upsertUser(user)
          }
          setResults(messages)
        })
        .catch((error) => {
          if (cancelled) return
          toast.error(
            error instanceof Error ? error.message : 'Поиск не удался',
          )
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [channelId, open, query, token])

  function openMessage(messageId: string) {
    setOpen(false)
    void navigate({
      to: `${prefix}/c/$channelId`,
      params: { channelId },
      search: { m: messageId },
    })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {variant === 'strip' ? (
          <button
            type="button"
            className={cn(
              'flex h-8 w-full items-center gap-2 rounded-md border border-input bg-muted/40 px-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted',
              stripClassName,
            )}
          >
            <SearchIcon className="size-4 shrink-0" />
            <span className="truncate">Поиск</span>
          </button>
        ) : (
          <button
            type="button"
            className={cn(
              'inline-flex size-8 shrink-0 items-center justify-center rounded-md text-sm transition-colors hover:bg-accent hover:text-accent-foreground',
              triggerClassName,
            )}
            title="Поиск по сообщениям"
          >
            <SearchIcon className="size-4" />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={6}
        className="w-80 p-0"
      >
        <div className="border-b p-2">
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск по сообщениям…"
            className="h-8"
          />
        </div>
        <ScrollArea className="max-h-80">
          <div className="flex flex-col gap-1 p-2">
            {searching ? (
              <p className="px-1 py-2 text-sm text-muted-foreground">Ищем…</p>
            ) : null}
            {!searching && query.trim().length < 2 ? (
              <p className="px-1 py-2 text-sm text-muted-foreground">
                Введите минимум 2 символа
              </p>
            ) : null}
            {!searching && query.trim().length >= 2 && results.length === 0 ? (
              <p className="px-1 py-2 text-sm text-muted-foreground">
                Ничего не найдено
              </p>
            ) : null}
            {results.map((message) => {
              const author = message.user ?? users[message.author]
              const name =
                author?.display_name ?? author?.username ?? 'Неизвестный'

              return (
                <button
                  key={message._id}
                  type="button"
                  className={cn(
                    'rounded-md border border-transparent px-2 py-2 text-left text-sm transition-colors hover:border-border hover:bg-muted/60',
                  )}
                  onClick={() => openMessage(message._id)}
                >
                  <p className="truncate text-xs font-medium text-muted-foreground">
                    {name}
                  </p>
                  {message.content ? (
                    <div className="line-clamp-2 text-sm">
                      {renderMessageContent(message.content, users, emojis)}
                    </div>
                  ) : (
                    <p className="text-sm italic text-muted-foreground">
                      [без текста]
                    </p>
                  )}
                </button>
              )
            })}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
