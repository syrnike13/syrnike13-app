import { useNavigate } from '@tanstack/react-router'
import { useTranslations } from '@syrnike13/ui/i18n'
import { useEffect, useId, useRef, useState } from 'react'
import type { Message, User } from '@syrnike13/api-types'
import { Effect, Fiber } from 'effect'

import { SearchIcon } from '#/components/icons'
import { Button } from '@syrnike13/ui/primitives/button'
import { Empty, EmptyDescription } from '@syrnike13/ui/primitives/empty'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@syrnike13/ui/primitives/input-group'
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemOverlay,
  ItemTitle,
} from '@syrnike13/ui/primitives/item'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@syrnike13/ui/primitives/popover'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
import { useAuth } from '#/features/auth/auth-context'
import { searchChannelMessagesEffect } from '#/features/api/messages-api'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { searchServerMessages } from '#/features/search/server-message-search'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { renderMessageContent } from '#/lib/message-markdown'
import { serverChannelServerId } from '#/lib/channel-voice'

/** Where the search looks: one channel (DM, group) or every text channel of a server. */
export type MessageSearchScope =
  | { kind: 'channel'; channelId: string }
  | { kind: 'server'; serverId: string }

type SearchHit = { channelId: string; channelLabel?: string; message: Message }

const MIN_QUERY_LENGTH = 2

function useMessageSearch(scope: MessageSearchScope, token: string, query: string, active: boolean) {
  const t = useTranslations('chat')
  const auth = useAuth()
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const scopeKey = scope.kind === 'channel' ? scope.channelId : scope.serverId

  useEffect(() => {
    const trimmed = query.trim()
    if (!active || trimmed.length < MIN_QUERY_LENGTH) {
      setHits([])
      setSearching(false)
      return
    }

    const search =
      scope.kind === 'channel'
        ? searchChannelMessagesEffect(token, scope.channelId, trimmed, 25).pipe(
            Effect.map(({ messages, users }) => ({
              users,
              hits: messages.map((message) => ({ channelId: scope.channelId, message })),
            })),
          )
        : searchServerMessages(
            token,
            syncStore.getState(),
            scope.serverId,
            trimmed,
            auth.user?._id,
            {},
            t,
          )

    const fiber = Effect.runFork(
      Effect.sleep(250).pipe(
        Effect.andThen(Effect.sync(() => setSearching(true))),
        Effect.andThen(search),
        Effect.matchEffect({
          onFailure: () =>
            Effect.sync(() => {
              setSearching(false)
            }),
          onSuccess: (result) =>
            Effect.sync(() => {
              syncStore.upsertUsers(result.users)
              setHits(result.hits)
              setSearching(false)
            }),
        }),
      ),
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
    // `scope` is identified by `scopeKey`.
  }, [active, auth.user?._id, query, scopeKey, token])

  return { hits, searching }
}

function SearchResults({
  query,
  hits,
  searching,
  users,
  onOpen,
}: {
  query: string
  hits: SearchHit[]
  searching: boolean
  users: Record<string, User>
  onOpen: (hit: SearchHit) => void
}) {
  const t = useTranslations('chat')
  const emojis = useSyncStore((s) => s.emojis)
  const channels = useSyncStore((s) => s.channels)
  const servers = useSyncStore((s) => s.servers)
  const ready = query.trim().length >= MIN_QUERY_LENGTH

  if (!ready || searching || hits.length === 0) {
    return (
      <Empty size="sm">
        <EmptyDescription>
          {!ready ? t('minChars') : searching ? t('searching') : t('nothingFound')}
        </EmptyDescription>
      </Empty>
    )
  }

  return (
    <ScrollArea className="max-h-96">
      <ul className="flex flex-col gap-0.5">
        {hits.map((hit) => {
          const author = hit.message.user ?? users[hit.message.author]
          const name = author?.display_name ?? author?.username ?? t('unknownAuthor')
          const serverId = serverChannelServerId(channels[hit.channelId])
          return (
            <Item key={`${hit.channelId}:${hit.message._id}`} size="sm" render={<li />}>
              <ItemOverlay aria-label={name} onClick={() => onOpen(hit)} />
              <ItemContent>
                <ItemTitle>{hit.channelLabel ? `${hit.channelLabel} · ${name}` : name}</ItemTitle>
                <ItemDescription>
                  {hit.message.content
                    ? renderMessageContent(hit.message.content, users, emojis, {
                        channels,
                        roles: serverId ? servers[serverId]?.roles : undefined,
                      })
                    : t('noText')}
                </ItemDescription>
              </ItemContent>
            </Item>
          )
        })}
      </ul>
    </ScrollArea>
  )
}

/**
 * Message search. `field` is the Discord header field: typing in it opens the
 * results under it. `icon` is a compact button that opens the same panel with
 * the field inside (mobile and voice-stage headers).
 */
export function MessageSearch({
  scope,
  token,
  users,
  variant = 'field',
  triggerVariant = 'ghost',
}: {
  scope: MessageSearchScope
  token: string
  users: Record<string, User>
  variant?: 'field' | 'icon'
  /** `media` on the voice stage header. */
  triggerVariant?: 'ghost' | 'media'
}) {
  const t = useTranslations('chat')
  const navigate = useNavigate()
  const prefix = useAppRoutePrefix()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const fieldRef = useRef<HTMLDivElement>(null)
  const resultsId = useId()
  const { hits, searching } = useMessageSearch(scope, token, query, open)
  const placeholder =
    scope.kind === 'server' ? t('searchServerPlaceholder') : t('searchMessagesPlaceholder')

  function close() {
    setOpen(false)
    setQuery('')
  }

  function openHit(hit: SearchHit) {
    close()
    if (scope.kind === 'server') syncStore.setSelectedServerId(scope.serverId)
    void navigate({
      to: `${prefix}/c/$channelId`,
      params: { channelId: hit.channelId },
      search: { m: hit.message._id },
    })
  }

  const field = (
    <InputGroup ref={fieldRef} size="sm">
      <InputGroupInput
        type="search"
        value={query}
        placeholder={placeholder}
        aria-label={placeholder}
        aria-controls={open ? resultsId : undefined}
        autoFocus={variant === 'icon'}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value)
          setOpen(true)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') close()
        }}
      />
      <InputGroupAddon align="inline-end">
        <SearchIcon />
      </InputGroupAddon>
    </InputGroup>
  )

  const results = (
    <SearchResults query={query} hits={hits} searching={searching} users={users} onOpen={openHit} />
  )

  if (variant === 'icon') {
    return (
      <Popover open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant={triggerVariant}
              size="icon"
              title={t('searchMessages')}
              aria-label={t('searchMessages')}
            />
          }
        >
          <SearchIcon />
        </PopoverTrigger>
        <PopoverContent id={resultsId} align="end" className="w-80">
          {field}
          {results}
        </PopoverContent>
      </Popover>
    )
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        // Pressing the field itself must not close the panel it controls.
        const target = details.event?.target
        if (!next && target instanceof Node && fieldRef.current?.contains(target)) return
        if (next) setOpen(true)
        else close()
      }}
    >
      {field}
      <PopoverContent
        id={resultsId}
        anchor={fieldRef}
        align="end"
        className="w-80"
        initialFocus={false}
        finalFocus={false}
      >
        {results}
      </PopoverContent>
    </Popover>
  )
}
