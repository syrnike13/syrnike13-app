import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { User } from '@syrnike13/api-types'
import { SearchIcon } from '#/components/icons'

import { Input } from '#/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { ScrollArea } from '#/components/ui/scroll-area'
import { MessageSearchPreview } from '#/components/chat/message-search-preview'
import { useAuth } from '#/features/auth/auth-context'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import {
  searchServerMessages,
  type ServerMessageSearchHit,
} from '#/features/search/server-message-search'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import {
  formatMessageTimestamp,
  messageCreatedAt,
} from '#/lib/message-time'
import { cn } from '#/lib/utils'

type ServerChannelSearchPopoverProps = {
  serverId: string
  token: string
  users: Record<string, User>
  variant?: 'strip' | 'icon'
}

export function ServerChannelSearchPopover({
  serverId,
  token,
  users,
  variant = 'strip',
}: ServerChannelSearchPopoverProps) {
  const auth = useAuth()
  const navigate = useNavigate()
  const prefix = useAppRoutePrefix()
  const emojis = useSyncStore((s) => s.emojis)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<ServerMessageSearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) {
      setQuery('')
      setHits([])
      setSearching(false)
      return
    }

    const timer = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    const trimmed = query.trim()
    if (!open || trimmed.length < 2) {
      setHits([])
      setSearching(false)
      return
    }

    let cancelled = false
    const timer = window.setTimeout(() => {
      setSearching(true)
      void searchServerMessages(
        token,
        syncStore.getState(),
        serverId,
        trimmed,
        auth.user?._id,
      )
        .then(({ hits: nextHits, users: foundUsers }) => {
          if (cancelled) return
          syncStore.upsertUsers(foundUsers)
          setHits(nextHits)
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [auth.user?._id, open, query, serverId, token])

  function openMessage(hit: ServerMessageSearchHit) {
    setOpen(false)
    syncStore.setSelectedServerId(serverId)
    void navigate({
      to: `${prefix}/c/$channelId`,
      params: { channelId: hit.channelId },
      search: { m: hit.message._id },
    })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {variant === 'strip' ? (
          <button
            type="button"
            className="flex h-8 w-full items-center gap-2 rounded-md border border-input bg-muted/40 px-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted"
          >
            <SearchIcon className="size-4 shrink-0" />
            <span className="truncate">Поиск</span>
          </button>
        ) : (
          <button
            type="button"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
            title="Поиск по серверу"
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
            placeholder="Поиск по серверу…"
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
            {!searching &&
            query.trim().length >= 2 &&
            hits.length === 0 ? (
              <p className="px-1 py-2 text-sm text-muted-foreground">
                Ничего не найдено
              </p>
            ) : null}
            {hits.map((hit) => {
              const author =
                hit.message.user ?? users[hit.message.author]
              const name =
                author?.display_name ?? author?.username ?? 'Неизвестный'
              const createdAt = messageCreatedAt(hit.message)
              const timestamp = formatMessageTimestamp(createdAt)

              return (
                <button
                  key={`${hit.channelId}:${hit.message._id}`}
                  type="button"
                  className={cn(
                    'rounded-md border border-transparent px-2 py-2 text-left text-sm transition-colors hover:border-border hover:bg-muted/60',
                  )}
                  onClick={() => openMessage(hit)}
                >
                  <p className="flex min-w-0 items-baseline gap-2 text-xs font-medium text-muted-foreground">
                    <span className="truncate">
                      {hit.channelLabel} · {name}
                    </span>
                    <time
                      className="shrink-0"
                      dateTime={createdAt.toISOString()}
                    >
                      {timestamp}
                    </time>
                  </p>
                  <MessageSearchPreview
                    message={hit.message}
                    users={users}
                    emojis={emojis}
                  />
                </button>
              )
            })}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
