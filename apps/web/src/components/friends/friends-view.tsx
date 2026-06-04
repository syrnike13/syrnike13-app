import { useNavigate } from '@tanstack/react-router'
import {
  BanIcon,
  MessageCircleIcon,
  ShieldOffIcon,
  UserCheckIcon,
  UserMinusIcon,
  UserPlusIcon,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { User } from '@syrnike13/api-types'
import { toast } from 'sonner'

import { UserAvatar } from '#/components/user/user-avatar'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { ScrollArea } from '#/components/ui/scroll-area'
import { useAuth } from '#/features/auth/auth-context'
import {
  acceptFriendRequest,
  blockUser,
  openDirectMessage,
  removeFriendOrRequest,
  sendFriendRequest,
  unblockUser,
} from '#/features/api/users-api'
import { listUsersByRelationship } from '#/features/sync/selectors'
import { syncStore, useSyncStore } from '#/features/sync/sync-store'
import { presenceLabel } from '#/lib/presence'

function userLabel(user: { username: string; display_name?: string | null }) {
  return user.display_name ?? user.username
}

function FriendRow({ user, children }: { user: User; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2">
      <UserAvatar user={user} fallbackClassName="size-9" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{userLabel(user)}</p>
        <p className="truncate text-xs text-muted-foreground">
          {presenceLabel(user)} · @{user.username}
        </p>
      </div>
      <div className="flex shrink-0 gap-1">{children}</div>
    </div>
  )
}

function FriendsSection({
  title,
  empty,
  children,
}: {
  title: string
  empty: string
  children: ReactNode
}) {
  const hasChildren = Array.isArray(children)
    ? children.length > 0
    : Boolean(children)

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-muted-foreground">{title}</h2>
      {hasChildren ? (
        <div className="flex flex-col gap-2">{children}</div>
      ) : (
        <p className="text-sm text-muted-foreground">{empty}</p>
      )}
    </section>
  )
}

function handleApiError(error: unknown, fallback: string) {
  toast.error(error instanceof Error ? error.message : fallback)
}

export function FriendsView() {
  const auth = useAuth()
  const navigate = useNavigate()
  const token = auth.session?.token
  const [username, setUsername] = useState('')
  const [sending, setSending] = useState(false)

  const friends = useSyncStore((s) =>
    listUsersByRelationship(s, 'Friend', auth.user?._id),
  )
  const incoming = useSyncStore((s) =>
    listUsersByRelationship(s, 'Incoming', auth.user?._id),
  )
  const outgoing = useSyncStore((s) =>
    listUsersByRelationship(s, 'Outgoing', auth.user?._id),
  )
  const blocked = useSyncStore((s) =>
    listUsersByRelationship(s, 'Blocked', auth.user?._id),
  )

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
      handleApiError(error, 'Не удалось открыть ЛС')
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
      toast.success('Заявка отправлена')
    } catch (error) {
      handleApiError(error, 'Не удалось отправить заявку')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="border-b px-4 py-3">
        <h1 className="text-lg font-semibold">Друзья</h1>
        <p className="text-sm text-muted-foreground">
          Заявки, друзья, блокировки
        </p>
      </header>

      <ScrollArea className="flex-1">
        <div className="space-y-6 p-4">
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-muted-foreground">
              Добавить по username
            </h2>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                void handleSendRequest()
              }}
            >
              <Input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="username или name#0000"
                disabled={sending}
              />
              <Button type="submit" disabled={sending}>
                <UserPlusIcon className="size-4" />
                Добавить
              </Button>
            </form>
          </section>

          <FriendsSection title="Друзья" empty="Пока нет друзей">
            {friends.map((user) => (
              <FriendRow key={user._id} user={user}>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  title="Написать"
                  onClick={() => void openDm(user._id)}
                >
                  <MessageCircleIcon className="size-4" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  title="Заблокировать"
                  onClick={() => {
                    if (!token) return
                    void blockUser(token, user._id)
                      .then((updated) => syncStore.upsertUser(updated))
                      .catch((error) =>
                        handleApiError(error, 'Не удалось заблокировать'),
                      )
                  }}
                >
                  <BanIcon className="size-4" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  title="Удалить из друзей"
                  onClick={() => {
                    if (!token) return
                    void removeFriendOrRequest(token, user._id)
                      .then((updated) => syncStore.upsertUser(updated))
                      .catch((error) =>
                        handleApiError(error, 'Ошибка'),
                      )
                  }}
                >
                  <UserMinusIcon className="size-4" />
                </Button>
              </FriendRow>
            ))}
          </FriendsSection>

          <FriendsSection
            title="Входящие заявки"
            empty="Нет входящих заявок"
          >
            {incoming.map((user) => (
              <FriendRow key={user._id} user={user}>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  title="Принять"
                  onClick={() => {
                    if (!token) return
                    void acceptFriendRequest(token, user._id)
                      .then((updated) => syncStore.upsertUser(updated))
                      .catch((error) =>
                        handleApiError(error, 'Ошибка'),
                      )
                  }}
                >
                  <UserCheckIcon className="size-4" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  title="Отклонить"
                  onClick={() => {
                    if (!token) return
                    void removeFriendOrRequest(token, user._id)
                      .then((updated) => syncStore.upsertUser(updated))
                      .catch((error) =>
                        handleApiError(error, 'Ошибка'),
                      )
                  }}
                >
                  <UserMinusIcon className="size-4" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  title="Заблокировать"
                  onClick={() => {
                    if (!token) return
                    void blockUser(token, user._id)
                      .then((updated) => syncStore.upsertUser(updated))
                      .catch((error) =>
                        handleApiError(error, 'Не удалось заблокировать'),
                      )
                  }}
                >
                  <BanIcon className="size-4" />
                </Button>
              </FriendRow>
            ))}
          </FriendsSection>

          <FriendsSection
            title="Исходящие заявки"
            empty="Нет исходящих заявок"
          >
            {outgoing.map((user) => (
              <FriendRow key={user._id} user={user}>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (!token) return
                    void removeFriendOrRequest(token, user._id)
                      .then((updated) => syncStore.upsertUser(updated))
                      .catch((error) =>
                        handleApiError(error, 'Ошибка'),
                      )
                  }}
                >
                  Отменить
                </Button>
              </FriendRow>
            ))}
          </FriendsSection>

          <FriendsSection title="Заблокированные" empty="Никого не блокируете">
            {blocked.map((user) => (
              <FriendRow key={user._id} user={user}>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (!token) return
                    void unblockUser(token, user._id)
                      .then((updated) => syncStore.upsertUser(updated))
                      .catch((error) =>
                        handleApiError(error, 'Не удалось разблокировать'),
                      )
                  }}
                >
                  <ShieldOffIcon className="size-4" />
                  Разблокировать
                </Button>
              </FriendRow>
            ))}
          </FriendsSection>
        </div>
      </ScrollArea>
    </div>
  )
}
