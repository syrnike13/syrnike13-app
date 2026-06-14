import { Link, useNavigate } from '@tanstack/react-router'
import {
  BanIcon,
  CopyIcon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  UserMinusIcon,
  UserPlusIcon,
  UsersIcon,
  XIcon,
} from '#/components/icons'
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { User } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { ActiveNowPanel } from '#/components/home/active-now-panel'
import { NotificationBadge } from '#/components/notifications/notification-badge'
import { UserAvatar } from '#/components/user/user-avatar'
import { Button } from '#/components/ui/button'
import { FloatingMenuItem } from '#/components/ui/floating-menu'
import { Input } from '#/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { ScrollArea } from '#/components/ui/scroll-area'
import { useAuth } from '#/features/auth/auth-context'
import { openDirectMessageChannel } from '#/features/dm/dm-actions'
import {
  acceptIncomingFriendRequest,
  blockUserRelationship,
  cancelOutgoingFriendRequest,
  declineIncomingFriendRequest,
  removeFriend,
  sendFriendRequestByUsername,
} from '#/features/friends/friend-actions'
import { selectFriendRequestNotificationBadge } from '#/features/notifications/notification-selectors'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { listUsersByRelationship } from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'
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

const rowIconActionClass =
  'size-9 shrink-0 rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground'

function HomeFriendRow({
  user,
  token,
  onMessage,
  onOpen,
  actions,
}: {
  user: User
  token?: string
  onMessage?: () => void
  onOpen?: () => void
  actions?: ReactNode
}) {
  const interactive = Boolean(onOpen)

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!onOpen || event.target !== event.currentTarget) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onOpen()
  }

  async function copyUserId() {
    try {
      await navigator.clipboard.writeText(user._id)
      toast.success('ID скопирован')
    } catch {
      toast.error('Не удалось скопировать')
    }
  }

  function handleBlock() {
    if (!token) return
    if (!window.confirm(`Заблокировать @${user.username}?`)) return
    void blockUserRelationship(token, user._id).catch(() => undefined)
  }

  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      className={cn(
        'flex items-center gap-3 border-b border-shell-divider px-4 py-3 last:border-b-0 hover:bg-muted/30',
        interactive &&
          'cursor-pointer outline-none focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50',
      )}
      onClick={onOpen}
      onKeyDown={handleKeyDown}
    >
      <UserAvatar user={user} className="size-10" fallbackClassName="size-10" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{userLabel(user)}</p>
        <p className="truncate text-sm text-muted-foreground">
          {presenceLabel(user)}
        </p>
      </div>
      <div
        className="flex shrink-0 items-center gap-1"
        onClick={(event) => event.stopPropagation()}
      >
        {actions}
        {onMessage ? (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={rowIconActionClass}
            title="Написать"
            aria-label="Написать"
            onClick={onMessage}
          >
            <MessageCircleIcon className="size-4" />
          </Button>
        ) : null}
        {token ? (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className={rowIconActionClass}
                title="Ещё"
                aria-label="Ещё"
              >
                <MoreHorizontalIcon className="size-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              side="bottom"
              align="end"
              className="w-auto min-w-[11rem] p-1"
              onOpenAutoFocus={(event) => event.preventDefault()}
            >
              {user.relationship === 'Incoming' ? (
                <FloatingMenuItem
                  onClick={() => {
                    void declineIncomingFriendRequest(token, user._id).catch(
                      () => undefined,
                    )
                  }}
                >
                  <XIcon className="size-3.5" />
                  Отклонить заявку
                </FloatingMenuItem>
              ) : null}
              {user.relationship === 'Outgoing' ? (
                <FloatingMenuItem
                  onClick={() => {
                    void cancelOutgoingFriendRequest(token, user._id).catch(
                      () => undefined,
                    )
                  }}
                >
                  <XIcon className="size-3.5" />
                  Отменить заявку
                </FloatingMenuItem>
              ) : null}
              {user.relationship === 'Friend' ? (
                <FloatingMenuItem
                  onClick={() => {
                    void removeFriend(token, user._id).catch(() => undefined)
                  }}
                >
                  <UserMinusIcon className="size-3.5" />
                  Удалить из друзей
                </FloatingMenuItem>
              ) : null}
              <FloatingMenuItem onClick={() => void copyUserId()}>
                <CopyIcon className="size-3.5" />
                Копировать ID
              </FloatingMenuItem>
              <FloatingMenuItem onClick={handleBlock}>
                <BanIcon className="size-3.5" />
                Заблокировать
              </FloatingMenuItem>
            </PopoverContent>
          </Popover>
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
  const prefix = useAppRoutePrefix()
  const token = auth.session?.token
  const [username, setUsername] = useState('')
  const [sending, setSending] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [friendSearch, setFriendSearch] = useState('')

  const friends = useSyncStore((s) =>
    listUsersByRelationship(s, 'Friend', auth.user?._id).filter(
      (user) => !user.bot,
    ),
  )
  const incoming = useSyncStore((s) =>
    listUsersByRelationship(s, 'Incoming', auth.user?._id).filter(
      (user) => !user.bot,
    ),
  )
  const outgoing = useSyncStore((s) =>
    listUsersByRelationship(s, 'Outgoing', auth.user?._id).filter(
      (user) => !user.bot,
    ),
  )
  const friendRequestBadge = useSyncStore((s) =>
    selectFriendRequestNotificationBadge(s, auth.user?._id),
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
        to: prefix,
        search: { tab: 'online' },
        replace: true,
      })
    }
  }, [tab, hasPending, navigate, prefix])

  const visibleUsers = usersForTab(tab, lists).filter((user) => {
    const q = friendSearch.trim().toLowerCase()
    if (!q) return true
    const label = (user.display_name ?? user.username).toLowerCase()
    return label.includes(q) || user.username.toLowerCase().includes(q)
  })

  async function openDm(userId: string) {
    if (!token) return
    await openDirectMessageChannel(token, userId, (channelId) =>
      navigate({
        to: `${prefix}/c/$channelId`,
        params: { channelId },
        search: { m: undefined },
      }),
    ).catch(() => undefined)
  }

  async function handleSendRequest() {
    if (!token) return
    const trimmed = username.trim()
    if (!trimmed) return

    setSending(true)
    try {
      await sendFriendRequestByUsername(token, trimmed)
      setUsername('')
      setAddOpen(false)
    } catch {
      // friend-actions already shows the concrete error toast.
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
                <Link to={prefix} search={{ tab: item.id }}>
                  <span className="inline-flex items-center gap-1.5">
                    {item.label}
                    {item.id === 'pending' ? (
                      <NotificationBadge badge={friendRequestBadge} />
                    ) : null}
                  </span>
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
                    token={token}
                    onOpen={
                      isOutgoing ? undefined : () => void openDm(user._id)
                    }
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
                                void acceptIncomingFriendRequest(
                                  token,
                                  user._id,
                                ).catch(() => undefined)
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
                              if (isIncoming) {
                                void declineIncomingFriendRequest(
                                  token,
                                  user._id,
                                ).catch(() => undefined)
                                return
                              }

                              void cancelOutgoingFriendRequest(
                                token,
                                user._id,
                              ).catch(() => undefined)
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
