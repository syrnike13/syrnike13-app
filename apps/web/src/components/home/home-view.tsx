import { Link, useNavigate } from '@tanstack/react-router'
import {
  BanIcon,
  CopyIcon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  SearchIcon,
  UserMinusIcon,
  UsersIcon,
  XIcon,
} from '#/components/icons'
import { useEffect, useId, useState, type ReactNode } from 'react'
import type { User } from '@syrnike13/api-types'
import { Effect } from 'effect'
import { toast } from 'sonner'

import { ActiveNowPanel } from '#/components/home/active-now-panel'
import { shellColumnHeaderClass } from '#/components/layout/shell-chrome'
import { NotificationBadge } from '#/components/notifications/notification-badge'
import { UserAvatar } from '#/components/user/user-avatar'
import { UserBlockDialog } from '#/components/user/user-block-dialog'
import { Button, buttonVariants } from '@syrnike13/ui/primitives/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@syrnike13/ui/primitives/dropdown-menu'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@syrnike13/ui/primitives/empty'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@syrnike13/ui/primitives/input-group'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemOverlay,
  ItemTitle,
} from '@syrnike13/ui/primitives/item'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
import { Separator } from '@syrnike13/ui/primitives/separator'
import { useAuth } from '#/features/auth/auth-context'
import { openDirectMessageChannel } from '#/features/dm/dm-actions'
import {
  acceptIncomingFriendRequest,
  blockUserRelationship,
  cancelOutgoingFriendRequest,
  declineIncomingFriendRequest,
  removeFriend,
  sendFriendRequestByUsername,
  unblockBlockedUser,
} from '#/features/friends/friend-actions'
import { selectFriendRequestNotificationBadge } from '#/features/notifications/notification-selectors'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { listUsersByRelationship } from '#/features/sync/selectors'
import { useSyncStore } from '#/features/sync/sync-store'
import { writeClipboardTextEffect } from '#/lib/clipboard'
import { isUserOnline, presenceLabel } from '#/lib/presence'
import { useTranslations } from '@syrnike13/ui/i18n'
import { cn } from '#/lib/utils'

export const HOME_TABS = ['online', 'all', 'pending', 'blocked', 'add'] as const
export type HomeTab = (typeof HOME_TABS)[number]
type ListTab = Exclude<HomeTab, 'add'>

const LIST_TABS: ListTab[] = ['online', 'all', 'pending', 'blocked']

function userLabel(user: { username: string; display_name?: string | null }) {
  return user.display_name ?? user.username
}

function HomeFriendRow({
  user,
  token,
  onOpen,
  actions,
}: {
  user: User
  token?: string
  onOpen?: () => void
  actions?: ReactNode
}) {
  const t = useTranslations('home.friends')
  const tf = useTranslations('friends')
  const tc = useTranslations('chat')
  const [blockDialogOpen, setBlockDialogOpen] = useState(false)
  const [blocking, setBlocking] = useState(false)
  const label = userLabel(user)

  async function copyUserId() {
    try {
      await Effect.runPromise(writeClipboardTextEffect(user._id))
      toast.success(t('idCopied'))
    } catch {
      toast.error(t('copyError'))
    }
  }

  async function handleBlock() {
    if (!token) return
    setBlocking(true)
    try {
      await Effect.runPromise(blockUserRelationship(token, user._id, tf))
      setBlockDialogOpen(false)
    } catch {
      // friend-actions already shows the error toast.
    } finally {
      setBlocking(false)
    }
  }

  return (
    <Item size="lg" render={<li />} data-avatar-hover-scope="">
      {onOpen ? (
        <ItemOverlay aria-label={t('openConversation', { name: label })} onClick={onOpen} />
      ) : null}
      <ItemMedia>
        <UserAvatar user={user} className="size-8" fallbackClassName="size-8" hoverScope="parent" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{label}</ItemTitle>
        <ItemDescription>{presenceLabel(user, tc)}</ItemDescription>
      </ItemContent>
      <ItemActions>
        {actions}
        {onOpen ? (
          <Button
            type="button"
            size="icon-lg"
            shape="circle"
            variant="ghost"
            className="text-muted-foreground"
            title={t('write')}
            aria-label={t('write')}
            onClick={onOpen}
          >
            <MessageCircleIcon />
          </Button>
        ) : null}
        {token && user.relationship !== 'Blocked' ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  size="icon-lg"
                  shape="circle"
                  variant="ghost"
                  className="text-muted-foreground"
                  title={t('more')}
                  aria-label={t('more')}
                />
              }
            >
              <MoreHorizontalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {user.relationship === 'Incoming' ? (
                <DropdownMenuItem
                  onClick={() => {
                    Effect.runFork(
                      declineIncomingFriendRequest(token, user._id, tf).pipe(Effect.ignore),
                    )
                  }}
                >
                  <XIcon />
                  {t('declineRequest')}
                </DropdownMenuItem>
              ) : null}
              {user.relationship === 'Outgoing' ? (
                <DropdownMenuItem
                  onClick={() => {
                    Effect.runFork(
                      cancelOutgoingFriendRequest(token, user._id, tf).pipe(Effect.ignore),
                    )
                  }}
                >
                  <XIcon />
                  {t('cancelRequest')}
                </DropdownMenuItem>
              ) : null}
              {user.relationship === 'Friend' ? (
                <DropdownMenuItem
                  onClick={() => {
                    Effect.runFork(removeFriend(token, user._id, tf).pipe(Effect.ignore))
                  }}
                >
                  <UserMinusIcon />
                  {t('removeFriend')}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onClick={() => void copyUserId()}>
                <CopyIcon />
                {t('copyId')}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={(event) => {
                  event.preventDefault()
                  setBlockDialogOpen(true)
                }}
              >
                <BanIcon />
                {t('block')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </ItemActions>
      {token ? (
        <UserBlockDialog
          user={user}
          open={blockDialogOpen}
          busy={blocking}
          onOpenChange={setBlockDialogOpen}
          onConfirm={() => void handleBlock()}
        />
      ) : null}
    </Item>
  )
}

function useRelationshipUsers(
  relationship: 'Friend' | 'Incoming' | 'Outgoing' | 'Blocked',
) {
  const auth = useAuth()
  return useSyncStore((s) =>
    listUsersByRelationship(s, relationship, auth.user?._id).filter((user) => !user.bot),
  )
}

function usersForTab(tab: ListTab, lists: RelationshipLists): User[] {
  switch (tab) {
    case 'online':
      return lists.Friend.filter((user) => isUserOnline(user))
    case 'all':
      return lists.Friend
    case 'pending':
      return [...lists.Incoming, ...lists.Outgoing]
    case 'blocked':
      return lists.Blocked
  }
}

type RelationshipLists = Record<'Friend' | 'Incoming' | 'Outgoing' | 'Blocked', User[]>

function useRelationshipLists(): RelationshipLists {
  return {
    Friend: useRelationshipUsers('Friend'),
    Incoming: useRelationshipUsers('Incoming'),
    Outgoing: useRelationshipUsers('Outgoing'),
    Blocked: useRelationshipUsers('Blocked'),
  }
}

/** Pending and Blocked exist only while they have someone in them. */
function visibleListTabs(lists: RelationshipLists): ListTab[] {
  return LIST_TABS.filter((item) => {
    if (item === 'pending') return lists.Incoming.length + lists.Outgoing.length > 0
    if (item === 'blocked') return lists.Blocked.length > 0
    return true
  })
}

function HomeTabsNav({ tab, tabs }: { tab: HomeTab; tabs: ListTab[] }) {
  const t = useTranslations('home.friends')
  const auth = useAuth()
  const prefix = useAppRoutePrefix()
  const friendRequestBadge = useSyncStore((s) =>
    selectFriendRequestNotificationBadge(s, auth.user?._id),
  )

  return (
    <nav aria-label={t('tabsLabel')} className="flex min-w-0 items-center gap-2">
      {tabs.map((item) => (
        <Link
          key={item}
          to={prefix || '/'}
          search={{ tab: item }}
          aria-current={tab === item ? 'page' : undefined}
          className={buttonVariants({
            variant: tab === item ? 'secondary' : 'ghost',
            size: 'sm',
          })}
        >
          {t(`tabs.${item}`)}
          {item === 'pending' ? <NotificationBadge badge={friendRequestBadge} /> : null}
        </Link>
      ))}
      <Link
        to={prefix || '/'}
        search={{ tab: 'add' }}
        aria-current={tab === 'add' ? 'page' : undefined}
        className={buttonVariants({
          variant: tab === 'add' ? 'secondary' : 'default',
          size: 'sm',
        })}
      >
        {t('tabs.add')}
      </Link>
    </nav>
  )
}

function AddFriendPanel() {
  const t = useTranslations('home.friends')
  const tf = useTranslations('friends')
  const auth = useAuth()
  const token = auth.session?.token
  const [username, setUsername] = useState('')
  const [sending, setSending] = useState(false)
  const titleId = useId()

  async function handleSendRequest() {
    const trimmed = username.trim()
    if (!token || !trimmed) return
    setSending(true)
    try {
      await Effect.runPromise(sendFriendRequestByUsername(token, trimmed, tf))
      setUsername('')
    } catch {
      // friend-actions already shows the concrete error toast.
    } finally {
      setSending(false)
    }
  }

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2 px-6 py-5">
      <h2 id={titleId} className="text-base font-semibold">
        {t('addTitle')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('addDescription')}</p>
      <form
        className="mt-2"
        onSubmit={(event) => {
          event.preventDefault()
          void handleSendRequest()
        }}
      >
        <InputGroup>
          <InputGroupInput
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder={t('usernamePlaceholder')}
            aria-label={t('usernamePlaceholder')}
            disabled={sending}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton type="submit" variant="default" disabled={sending || !username.trim()}>
              {t('send')}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </form>
    </section>
  )
}

function FriendsList({ tab, lists }: { tab: ListTab; lists: RelationshipLists }) {
  const t = useTranslations('home.friends')
  const tf = useTranslations('friends')
  const tu = useTranslations('users')
  const auth = useAuth()
  const navigate = useNavigate()
  const prefix = useAppRoutePrefix()
  const token = auth.session?.token
  const [search, setSearch] = useState('')
  const headingId = useId()

  const query = search.trim().toLowerCase()
  const visibleUsers = usersForTab(tab, lists).filter(
    (user) =>
      !query ||
      userLabel(user).toLowerCase().includes(query) ||
      user.username.toLowerCase().includes(query),
  )

  async function openDm(userId: string) {
    if (!token) return
    await Effect.runPromise(
      openDirectMessageChannel(
        token,
        userId,
        (channelId) =>
          navigate({
            to: `${prefix}/c/$channelId`,
            params: { channelId },
            search: { m: undefined },
          }),
        tu,
      ).pipe(Effect.ignore),
    )
  }

  function rowActions(user: User): ReactNode {
    if (!token) return null
    if (tab === 'blocked') {
      return (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => {
            Effect.runFork(unblockBlockedUser(token, user._id, tf).pipe(Effect.ignore))
          }}
        >
          {t('unblock')}
        </Button>
      )
    }
    if (tab !== 'pending') return null
    const incoming = user.relationship === 'Incoming'
    return (
      <>
        {incoming ? (
          <Button
            type="button"
            size="sm"
            onClick={() => {
              Effect.runFork(acceptIncomingFriendRequest(token, user._id, tf).pipe(Effect.ignore))
            }}
          >
            {t('accept')}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => {
            const action = incoming ? declineIncomingFriendRequest : cancelOutgoingFriendRequest
            Effect.runFork(action(token, user._id, tf).pipe(Effect.ignore))
          }}
        >
          {incoming ? t('decline') : t('cancel')}
        </Button>
      </>
    )
  }

  const heading = t(`${tab}Count`, { count: visibleUsers.length })
  const emptyTitle = t(`empty.${tab}`)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-6 pt-4 pb-2">
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
          />
        </InputGroup>
      </div>

      {visibleUsers.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{emptyTitle}</EmptyTitle>
            {query ? <EmptyDescription>{t('emptySearch')}</EmptyDescription> : null}
          </EmptyHeader>
        </Empty>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <section aria-labelledby={headingId} className="flex flex-col gap-2 px-4 pb-4">
            <h2
              id={headingId}
              className="px-2 pt-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
            >
              {heading}
            </h2>
            <ul className="flex flex-col">
              {visibleUsers.map((user) => (
                <HomeFriendRow
                  key={user._id}
                  user={user}
                  token={token}
                  onOpen={
                    user.relationship === 'Outgoing' || user.relationship === 'Blocked'
                      ? undefined
                      : () => void openDm(user._id)
                  }
                  actions={rowActions(user)}
                />
              ))}
            </ul>
          </section>
        </ScrollArea>
      )}
    </div>
  )
}

export function HomeView({ tab }: { tab: HomeTab }) {
  const t = useTranslations('home.friends')
  const navigate = useNavigate()
  const prefix = useAppRoutePrefix()
  const lists = useRelationshipLists()
  const tabs = visibleListTabs(lists)
  const tabHidden = tab !== 'add' && !tabs.includes(tab)

  useEffect(() => {
    if (!tabHidden) return
    void navigate({ to: prefix || '/', search: { tab: 'online' }, replace: true })
  }, [tabHidden, navigate, prefix])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className={cn(shellColumnHeaderClass, 'px-4')}>
        <UsersIcon className="size-5 shrink-0 text-muted-foreground" />
        <h1 className="text-base font-semibold">{t('title')}</h1>
        <div className="mx-2 flex h-6">
          <Separator orientation="vertical" />
        </div>
        <HomeTabsNav tab={tab} tabs={tabs} />
      </header>
      <div className="flex min-h-0 flex-1">
        {tab === 'add' ? (
          <AddFriendPanel />
        ) : (
          <FriendsList tab={tabHidden ? 'online' : tab} lists={lists} />
        )}
        <ActiveNowPanel />
      </div>
    </div>
  )
}
