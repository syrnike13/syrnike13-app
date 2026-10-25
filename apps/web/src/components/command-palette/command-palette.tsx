import { useMatch, useNavigate } from '@tanstack/react-router'
import {
  BugIcon,
  HashIcon,
  HomeIcon,
  MessageSquareIcon,
  ServerIcon,
  SettingsIcon,
  UserIcon,
  UsersIcon,
} from '#/components/icons'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Message } from '@syrnike13/api-types'
import { Effect, Fiber } from 'effect'
import { useTranslations } from '@syrnike13/ui/i18n'

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem as CommandMenuItem,
  CommandList,
} from '@syrnike13/ui/primitives/command'
import { Kbd, KbdGroup } from '@syrnike13/ui/primitives/kbd'
import {
  buildCommandItems,
  channelLabelForMessage,
  messageSearchChannelIds,
} from '#/features/command-palette/build-command-items'
import type { CommandItem } from '#/features/command-palette/types'
import { useCommandPalette } from '#/features/command-palette/command-palette-context'
import { searchChannelMessagesEffect } from '#/features/api/messages-api'
import { useAuth } from '#/features/auth/auth-context'
import { useSettingsModal } from '#/features/settings/settings-modal-context'
import { syncStore } from '#/features/sync/sync-store'
import { messagePreviewText } from '#/lib/message-format/preview-text'

function groupIcon(group: string) {
  switch (group) {
    case 'navigation':
      return HomeIcon
    case 'servers':
      return ServerIcon
    case 'channels':
      return HashIcon
    case 'dms':
      return MessageSquareIcon
    case 'friends':
      return UsersIcon
    case 'messages':
      return MessageSquareIcon
    case 'settings':
      return SettingsIcon
    case 'debug':
      return BugIcon
    default:
      return UserIcon
  }
}

export function CommandPalette() {
  const t = useTranslations('commandPalette')
  const tChat = useTranslations('chat')
  const { open, setOpen } = useCommandPalette()
  const auth = useAuth()
  const navigate = useNavigate()
  const { openSettings } = useSettingsModal()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [selectedItemId, setSelectedItemId] = useState<string | undefined>()
  const [messageHits, setMessageHits] = useState<
    Array<{ message: Message; channelId: string; channelLabel: string }>
  >([])
  const [searchingMessages, setSearchingMessages] = useState(false)

  const channelMatch = useMatch({
    from: '/_app/c/$channelId',
    shouldThrow: false,
  })
  const activeChannelId = channelMatch?.params?.channelId

  const staticItems = useMemo(() => {
    if (!open) return []
    return buildCommandItems({
      state: syncStore.getState(),
      currentUserId: auth.user?._id,
      query,
      activeChannelId,
      navigate: (opts) => navigate(opts as never),
      setSelectedServerId: syncStore.setSelectedServerId,
      openSettings: () => openSettings('account'),
      t,
      tChat,
    })
  }, [open, auth.user?._id, query, activeChannelId, navigate, openSettings, t, tChat])

  const messageItems = useMemo((): CommandItem[] => {
    return messageHits.map((hit) => ({
      id: `msg-${hit.message._id}`,
      group: 'messages',
      label:
        (hit.message.content
          ? messagePreviewText(hit.message.content, syncStore.getState()).slice(0, 80)
          : '') || t('attachment'),
      subtitle: hit.channelLabel,
      keywords: hit.message.content ?? '',
      score: 50,
      run: () => {
        const channel = syncStore.getState().channels[hit.channelId]
        if (channel?.channel_type === 'TextChannel') {
          syncStore.setSelectedServerId(channel.server)
        } else {
          syncStore.setSelectedServerId(null)
        }
        void navigate({
          to: '/c/$channelId',
          params: { channelId: hit.channelId },
          search: { m: hit.message._id },
        })
      },
    }))
  }, [messageHits, navigate, t])

  const items = useMemo(
    () => [...staticItems, ...messageItems].slice(0, 50),
    [staticItems, messageItems],
  )

  const grouped = useMemo(() => {
    const map = new Map<string, CommandItem[]>()
    for (const item of items) {
      const list = map.get(item.group) ?? []
      list.push(item)
      map.set(item.group, list)
    }
    return [...map.entries()]
  }, [items])

  useEffect(() => {
    if (!open) {
      setQuery('')
      setMessageHits([])
      return
    }
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    setSelectedItemId(items[0]?.id)
  }, [query])

  useEffect(() => {
    const trimmed = query.trim()
    const token = auth.session?.token
    if (!open || !token || trimmed.length < 2) {
      setMessageHits([])
      setSearchingMessages(false)
      return
    }

    const snapshot = syncStore.getState()
    const channelIds = messageSearchChannelIds(
      snapshot,
      activeChannelId,
      auth.user?._id,
    )

    const fiber = Effect.runFork(
      Effect.gen(function*() {
        yield* Effect.sleep(280)
        yield* Effect.sync(() => setSearchingMessages(true))

        const batches = yield* Effect.all(
          channelIds.map((channelId) =>
            searchChannelMessagesEffect(token, channelId, trimmed, 8).pipe(
              Effect.flatMap(({ messages, users }) =>
                Effect.sync(() => {
                  syncStore.upsertUsers(users)
                  const state = syncStore.getState()
                  const channel = state.channels[channelId]
                  const channelLabel = channel
                    ? channelLabelForMessage(
                        channel,
                        state,
                        auth.user?._id,
                        tChat,
                      )
                    : t('channel')
                  return messages.map((message) => ({
                    message,
                    channelId,
                    channelLabel,
                  }))
                }),
              ),
              Effect.catch(() => Effect.succeed([])),
            ),
          ),
          { concurrency: 'unbounded' },
        )

        yield* Effect.sync(() => {
          const flat = batches.flat().slice(0, 12)
          setMessageHits(flat)
          setSearchingMessages(false)
        })
      }),
    )

    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [open, query, auth.session?.token, activeChannelId, auth.user?._id, t])

  function runItem(item: CommandItem) {
    setOpen(false)
    item.run()
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title={t('title')}
      description={t('description')}
      showCloseButton={false}
      className="sm:max-w-xl"
    >
      <Command
        shouldFilter={false}
        value={selectedItemId}
        onValueChange={setSelectedItemId}
      >
        <CommandInput
          ref={inputRef}
          value={query}
          onValueChange={setQuery}
          placeholder={t('placeholder')}
        />

        <CommandList className="max-h-command-palette">
          <CommandEmpty>
            {searchingMessages
              ? t('searching')
              : query.trim()
                ? t('noResults')
                : t('typeQuery')}
          </CommandEmpty>

          {grouped.map(([group, groupItems]) => {
            const Icon = groupIcon(group)
            return (
              <CommandGroup key={group} heading={t(`groups.${group}`)}>
                {groupItems.map((item) => (
                  <CommandMenuItem
                    key={item.id}
                    value={item.id}
                    className="gap-3"
                    onSelect={() => runItem(item)}
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {item.label}
                      </span>
                      {item.subtitle ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {item.subtitle}
                        </span>
                      ) : null}
                    </span>
                  </CommandMenuItem>
                ))}
              </CommandGroup>
            )
          })}
        </CommandList>

        <div className="mt-1 flex items-center justify-between border-t border-border px-2 py-2 text-xs text-muted-foreground">
          <span>{t('footer')}</span>
          <KbdGroup>
            <Kbd>Ctrl</Kbd>
            <span>+</span>
            <Kbd>K</Kbd>
          </KbdGroup>
        </div>
      </Command>
    </CommandDialog>
  )
}
