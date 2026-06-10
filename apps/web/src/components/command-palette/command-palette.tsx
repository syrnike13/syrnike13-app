import { useMatch, useNavigate } from '@tanstack/react-router'
import {
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

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '#/components/ui/dialog'
import { ScrollArea } from '#/components/ui/scroll-area'
import {
  buildCommandItems,
  channelLabelForMessage,
  messageSearchChannelIds,
} from '#/features/command-palette/build-command-items'
import type { CommandItem } from '#/features/command-palette/types'
import { useCommandPalette } from '#/features/command-palette/command-palette-context'
import { searchChannelMessages } from '#/features/api/messages-api'
import { useAuth } from '#/features/auth/auth-context'
import { useSettingsModal } from '#/features/settings/settings-modal-context'
import { syncStore } from '#/features/sync/sync-store'
import { cn } from '#/lib/utils'

function groupIcon(group: string) {
  switch (group) {
    case 'Навигация':
      return HomeIcon
    case 'Серверы':
      return ServerIcon
    case 'Каналы':
      return HashIcon
    case 'Личные сообщения':
      return MessageSquareIcon
    case 'Друзья':
      return UsersIcon
    case 'Сообщения':
      return MessageSquareIcon
    case 'Настройки':
      return SettingsIcon
    default:
      return UserIcon
  }
}

export function CommandPalette() {
  const { open, setOpen } = useCommandPalette()
  const auth = useAuth()
  const navigate = useNavigate()
  const { openSettings } = useSettingsModal()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [messageHits, setMessageHits] = useState<
    Array<{ message: Message; channelId: string; channelLabel: string }>
  >([])
  const [searchingMessages, setSearchingMessages] = useState(false)

  const channelMatch = useMatch({
    from: '/app/c/$channelId',
    shouldThrow: false,
  })
  const activeChannelId = channelMatch?.params.channelId

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
    })
  }, [open, auth.user?._id, query, activeChannelId, navigate, openSettings])

  const messageItems = useMemo((): CommandItem[] => {
    return messageHits.map((hit) => ({
      id: `msg-${hit.message._id}`,
      group: 'Сообщения',
      label: hit.message.content?.slice(0, 80) || 'Вложение',
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
          to: '/app/c/$channelId',
          params: { channelId: hit.channelId },
          search: { m: hit.message._id },
        })
      },
    }))
  }, [messageHits, navigate])

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
      setActiveIndex(0)
      setMessageHits([])
      return
    }
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    setActiveIndex(0)
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
    const channelIds = messageSearchChannelIds(snapshot, activeChannelId)
    let cancelled = false
    const timer = window.setTimeout(() => {
      setSearchingMessages(true)
      void Promise.all(
        channelIds.map(async (channelId) => {
          try {
            const { messages, users } = await searchChannelMessages(
              token,
              channelId,
              trimmed,
              8,
            )
            syncStore.upsertUsers(users)
            const state = syncStore.getState()
            const channel = state.channels[channelId]
            const channelLabel = channel
              ? channelLabelForMessage(channel, state, auth.user?._id)
              : 'Канал'
            return messages.map((message) => ({
              message,
              channelId,
              channelLabel,
            }))
          } catch {
            return []
          }
        }),
      )
        .then((batches) => {
          if (cancelled) return
          const flat = batches.flat().slice(0, 12)
          setMessageHits(flat)
        })
        .finally(() => {
          if (!cancelled) setSearchingMessages(false)
        })
    }, 280)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, query, auth.session?.token, activeChannelId, auth.user?._id])

  function runItem(item: CommandItem) {
    setOpen(false)
    item.run()
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => Math.min(index + 1, items.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter' && items[activeIndex]) {
      event.preventDefault()
      runItem(items[activeIndex])
    }
  }

  let flatIndex = 0

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <DialogTitle className="sr-only">Быстрый поиск</DialogTitle>
        <DialogDescription className="sr-only">
          Поиск по каналам, друзьям и сообщениям. Ctrl+K
        </DialogDescription>
        <div className="flex items-center gap-3 border-b px-4">
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Куда перейти? Кого найти?"
            className="h-12 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 md:text-sm [&::-webkit-search-cancel-button]:hidden"
          />
          <kbd className="hidden shrink-0 rounded border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">
            Esc
          </kbd>
        </div>

        <ScrollArea className="max-h-[min(60vh,420px)]">
          {items.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">
              {searchingMessages
                ? 'Ищем сообщения…'
                : query.trim()
                  ? 'Ничего не найдено'
                  : 'Введите запрос или выберите пункт'}
            </p>
          ) : (
            <div className="p-2">
              {grouped.map(([group, groupItems]) => {
                const Icon = groupIcon(group)
                return (
                  <div key={group} className="mb-2 last:mb-0">
                    <p className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                      {group}
                    </p>
                    <ul>
                      {groupItems.map((item) => {
                        const index = flatIndex++
                        const active = index === activeIndex
                        return (
                          <li key={item.id}>
                            <button
                              type="button"
                              className={cn(
                                'flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm',
                                active && 'bg-accent text-accent-foreground',
                              )}
                              onMouseEnter={() => setActiveIndex(index)}
                              onClick={() => runItem(item)}
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
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )
              })}
            </div>
          )}
        </ScrollArea>

        <div className="flex items-center justify-between border-t bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          <span>↑↓ выбор · Enter открыть</span>
          <span>
            <kbd className="rounded border bg-background px-1">Ctrl</kbd>+
            <kbd className="rounded border bg-background px-1">K</kbd>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
