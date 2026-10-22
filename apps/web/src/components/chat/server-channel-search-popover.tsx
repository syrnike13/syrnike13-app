import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslations } from '@syrnike13/ui/i18n'
import type { User } from '@syrnike13/api-types'
import { Effect, Fiber } from 'effect'
import { SearchIcon } from '#/components/icons'

import { Button } from '@syrnike13/ui/primitives/button'
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from '@syrnike13/ui/primitives/command'
import { Empty, EmptyDescription } from '@syrnike13/ui/primitives/empty'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@syrnike13/ui/primitives/popover'
import { useAuth } from '#/features/auth/auth-context'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import {
  searchServerMessages,
  type ServerMessageSearchHit,
} from '#/features/search/server-message-search'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { renderMessageContent } from '#/lib/message-markdown'

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
  const t = useTranslations('chat')
  const auth = useAuth()
  const navigate = useNavigate()
  const prefix = useAppRoutePrefix()
  const emojis = useSyncStore((s) => s.emojis)
  const channels = useSyncStore((s) => s.channels)
  const server = useSyncStore((s) => s.servers[serverId])
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

    const fiber = Effect.runFork(
      Effect.sleep(250).pipe(
        Effect.andThen(Effect.sync(() => setSearching(true))),
        Effect.andThen(
          searchServerMessages(
            token,
            syncStore.getState(),
            serverId,
            trimmed,
            auth.user?._id,
            {},
            t,
          ),
        ),
        Effect.matchEffect({
          onFailure: () => Effect.sync(() => setSearching(false)),
          onSuccess: ({ hits: nextHits, users: foundUsers }) =>
            Effect.sync(() => {
              syncStore.upsertUsers(foundUsers)
              setHits(nextHits)
              setSearching(false)
            }),
        }),
      ),
    )

    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
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

  const triggerElement =
    variant === 'strip' ? (
      <Button
        type="button"
        variant="outline"
        className="w-full justify-start font-normal"
      >
        <SearchIcon className="size-4 shrink-0" />
        <span className="truncate">{t('search')}</span>
      </Button>
    ) : (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="shrink-0"
        title={t('searchServer')}
        aria-label={t('searchServer')}
      >
        <SearchIcon className="size-4" />
      </Button>
    )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={triggerElement} />
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={6}
        className="w-80 p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput
            ref={inputRef}
            value={query}
            onValueChange={setQuery}
            placeholder={t('searchServerPlaceholder')}
          />
          <CommandList className="max-h-80 p-2">
            {searching ? (
              <p className="px-1 py-2 text-sm text-muted-foreground">
                {t('searching')}
              </p>
            ) : null}
            {!searching && query.trim().length < 2 ? (
              <p className="px-1 py-2 text-sm text-muted-foreground">
                {t('minChars')}
              </p>
            ) : null}
            {!searching &&
            query.trim().length >= 2 &&
            hits.length === 0 ? (
              <Empty className="px-1 py-2">
                <EmptyDescription>{t('nothingFound')}</EmptyDescription>
              </Empty>
            ) : null}
            {hits.map((hit) => {
              const author =
                hit.message.user ?? users[hit.message.author]
              const name =
                author?.display_name ?? author?.username ?? t('unknownAuthor')

              return (
                <CommandItem
                  key={`${hit.channelId}:${hit.message._id}`}
                  value={`${hit.channelId}:${hit.message._id}`}
                  className="items-start px-2 py-2"
                  onSelect={() => openMessage(hit)}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-muted-foreground">
                      {hit.channelLabel} · {name}
                    </p>
                    {hit.message.content ? (
                      <div className="line-clamp-2 select-text text-sm">
                        {renderMessageContent(hit.message.content, users, emojis, {
                          channels,
                          roles: server?.roles,
                        })}
                      </div>
                    ) : (
                      <p className="text-sm italic text-muted-foreground">
                        {t('noText')}
                      </p>
                    )}
                  </div>
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
