import { Link, useNavigate } from '@tanstack/react-router'
import { MessageCircleIcon, UserPlusIcon, UsersIcon } from '#/components/icons'
import { useEffect, useState, type ReactNode } from 'react'
import type { User } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { ActiveNowPanel } from '#/components/home/active-now-panel'
import { UserAvatar } from '#/components/user/user-avatar'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { ScrollArea } from '#/components/ui/scroll-area'
import { useAuth } from '#/features/auth/auth-context'
import {
  acceptFriendRequest,
  openDirectMessage,
  removeFriendOrRequest,
  sendFriendRequest,
} from '#/features/api/users-api'
import { listUsersByRelationship } from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { isUserOnline, presenceLabel } from '#/lib/presence'
import { cn } from '#/lib/utils'

export type HomeTab = 'online' | 'all' | 'pending'

const TABS: { id: HomeTab; label: string }[] = [
  { id: 'online', label: 'В сети' },
  { id: 'all', label: 'Все' },
  { id: 'pending', label: 'Заявки' },
]

function userLabel(user: { username: string; display_name?: string | null }) {
  return user.display_name ?? user.username
}

function HomeFriendRow({
  user,
  onMessage,
  actions,
}: {
  user: User
  onMessage?: () => void
  actions?: ReactNode
}) {
  return (
    <div className="flex items-center gap-3 border-b border-shell-divider px-4 py-3 last:border-b-0 hover:bg-muted/30">
      <UserAvatar user={user} className="size-10" fallbackClassName="size-10" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{userLabel(user)}</p>
        <p className="truncate text-sm text-muted-foreground">
          {presenceLabel(user)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {actions}
        {onMessage ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-9 shrink-0 rounded-full bg-muted/50"
            title="Написать"
            onClick={onMessage}
          >
            <MessageCircleIcon className="size-4" />
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function usersForTab(
  tab: HomeTab,
  lists: Record<'Friend' | 'Incoming' | 'Outgoing', User[]>,
): User[] {
  switch (tab) {
    case 'online':
      return lists.Friend.filter((user) => isUserOnline(user))
    case 'all':
      return lists.Friend
    case 'pending':
      return [...lists.Incoming, ...lists.Outgoing]
    default:
      return lists.Friend
  }
}

type HomeViewProps = {
  tab: HomeTab
}

export function HomeView({ tab }: HomeViewProps) {
  const auth = useAuth()
  const navigate = useNavigate()
  const token = auth.session?.token
  const [username, setUsername] = useState('')
  const [sending, setSending] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [friendSearch, setFriendSearch] = useState('')

  const friends = useSyncStore((s) =>
    listUsersByRelationship(s, 'Friend', auth.user?._id),
  )
  const incoming = useSyncStore((s) =>
    listUsersByRelationship(s, 'Incoming', auth.user?._id),
  )
  const outgoing = useSyncStore((s) =>
    listUsersByRelationship(s, 'Outgoing', auth.user?._id),
  )

  const lists = {
    Friend: friends,
    Incoming: incoming,
    Outgoing: outgoing,
  }
  const hasPending = incoming.length > 0 || outgoing.length > 0
  const visibleTabs = TABS.filter(
    (item) => item.id !== 'pending' || hasPending,
  )

  useEffect(() => {
    if (tab === 'pending' && !hasPending) {
      void navigate({
        to: '/app',
        search: { tab: 'online' },
        replace: true,
      })
    }
  }, [tab, hasPending, navigate])

  const visibleUsers = usersForTab(tab, lists).filter((user) => {
    const q = friendSearch.trim().toLowerCase()
    if (!q) return true
    const label = (user.display_name ?? user.username).toLowerCase()
    return label.includes(q) || user.username.toLowerCase().includes(q)
  })

  async function openDm(userId: string) {
    if (!token) return
    try {
      const channel = await openDirectMessage(token, userId)
      syncStore.upsertChannel(channel)
      syncStore.setSelectedServerId(null)
      await navigate({
        to: '/app/c/$channelId',
        params: { channelId: channel._id },
      })
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось открыть ЛС',
      )
    }
  }

  async function handleSendRequest() {
    if (!token) return
    const trimmed = username.trim()
    if (!trimmed) return

    setSending(true)
    try {
      const user = await sendFriendRequest(token, trimmed)
      syncStore.upsertUser(user)
      setUsername('')
      setAddOpen(false)
      toast.success('Заявка отправлена')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Не удалось отправить',
      )
    } finally {
      setSending(false)
    }
  }

  const sectionTitle =
    tab === 'online'
      ? `В сети — ${visibleUsers.length}`
      : tab === 'all'
        ? `Все друзья — ${visibleUsers.length}`
        : `Заявки — ${visibleUsers.length}`

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-shell-divider px-4 py-3">
          <div className="flex shrink-0 items-center gap-2">
            <UsersIcon className="size-5 shrink-0 text-muted-foreground" />
            <span className="text-sm font-semibold">Друзья</span>
          </div>
          <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {visibleTabs.map((item) => (
              <Button
                key={item.id}
                variant={tab === item.id ? 'secondary' : 'ghost'}
                size="sm"
                className={cn(
                  'shrink-0 rounded-md',
                  tab === item.id && 'bg-muted',
                )}
                asChild
              >
                <Link to="/app" search={{ tab: item.id }}>
                  {item.label}
                </Link>
              </Button>
            ))}
          </nav>
          <Button
            type="button"
            size="sm"
            className="shrink-0"
            onClick={() => setAddOpen((open) => !open)}
          >
            <UserPlusIcon className="size-4" data-icon="inline-start" />
            Добавить
          </Button>
        </header>

        {addOpen ? (
          <div className="border-b border-shell-divider bg-muted/20 px-4 py-3">
            <form
              className="flex max-w-md gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                void handleSendRequest()
              }}
            >
              <Input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="username"
                disabled={sending}
              />
              <Button type="submit" disabled={sending}>
                Отправить
              </Button>
            </form>
          </div>
        ) : null}

        <div className="border-b border-shell-divider px-4 py-2">
          <Input
            value={friendSearch}
            onChange={(event) => setFriendSearch(event.target.value)}
            placeholder="Поиск по друзьям"
            className="h-9 max-w-md bg-muted/30"
          />
        </div>

        <p className="px-4 py-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {sectionTitle}
        </p>

        <ScrollArea className="flex-1">
          {visibleUsers.length === 0 ? (
            <p className="px-4 py-8 text-sm text-muted-foreground">
              {tab === 'online'
                ? 'Нет друзей в сети'
                : tab === 'pending'
                  ? 'Нет заявок'
                  : 'Пока нет друзей'}
            </p>
          ) : (
            <div>
              {visibleUsers.map((user) => {
                const isIncoming = incoming.some((u) => u._id === user._id)
                const isOutgoing = outgoing.some((u) => u._id === user._id)

                return (
                  <HomeFriendRow
                    key={user._id}
                    user={user}
                    onMessage={
                      isOutgoing ? undefined : () => void openDm(user._id)
                    }
                    actions={
                      tab === 'pending' && token ? (
                        <>
                          {isIncoming ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                void acceptFriendRequest(token, user._id)
                                  .then((updated) =>
                                    syncStore.upsertUser(updated),
                                  )
                                  .catch((error) =>
                                    toast.error(
                                      error instanceof Error
                                        ? error.message
                                        : 'Ошибка',
                                    ),
                                  )
                              }}
                            >
                              Принять
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              void removeFriendOrRequest(token, user._id)
                                .then((updated) =>
                                  syncStore.upsertUser(updated),
                                )
                                .catch((error) =>
                                  toast.error(
                                    error instanceof Error
                                      ? error.message
                                      : 'Ошибка',
                                  ),
                                )
                            }}
                          >
                            {isOutgoing ? 'Отменить' : 'Отклонить'}
                          </Button>
                        </>
                      ) : null
                    }
                  />
                )
              })}
            </div>
          )}
        </ScrollArea>
      </div>

      <ActiveNowPanel />
    </div>
  )
}
