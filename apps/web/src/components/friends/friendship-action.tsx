import type { User } from '@syrnike13/api-types'
import { useState } from 'react'

import {
  Loader2Icon,
  ShieldOffIcon,
  UserCheckIcon,
  UserMinusIcon,
  UserPlusIcon,
  XIcon,
} from '#/components/icons'
import { Button } from '#/components/ui/button'
import { ContextMenuItem } from '#/components/ui/context-menu'
import { useAuth } from '#/features/auth/auth-context'
import {
  acceptIncomingFriendRequest,
  cancelOutgoingFriendRequest,
  declineIncomingFriendRequest,
  removeFriend,
  sendFriendRequestToUser,
  unblockBlockedUser,
} from '#/features/friends/friend-actions'
import { cn } from '#/lib/utils'

type FriendshipActionProps = {
  user: User
  className?: string
}

function shouldHideFriendshipAction(
  user: User,
  currentUserId: string | undefined,
) {
  return (
    user._id === currentUserId ||
    user.relationship === 'User' ||
    user.relationship === 'BlockedOther' ||
    Boolean(user.bot)
  )
}

export function FriendshipAction({ user, className }: FriendshipActionProps) {
  const auth = useAuth()
  const token = auth.session?.token
  const [busy, setBusy] = useState(false)

  if (shouldHideFriendshipAction(user, auth.user?._id)) return null

  async function run(action: () => Promise<unknown>) {
    if (!token || busy) return
    setBusy(true)
    try {
      await action()
    } catch {
      // friend-actions already shows the concrete error toast.
    } finally {
      setBusy(false)
    }
  }

  const disabled = busy || !token
  const pendingIcon = busy ? (
    <Loader2Icon className="size-4 animate-spin" data-icon="inline-start" />
  ) : null

  if (user.relationship === 'Incoming') {
    return (
      <div className={cn('flex gap-1.5', className)}>
        <Button
          type="button"
          size="sm"
          disabled={disabled}
          className="min-w-0 flex-1"
          onClick={() =>
            void run(() => acceptIncomingFriendRequest(token!, user._id))
          }
        >
          {pendingIcon ?? <UserCheckIcon data-icon="inline-start" />}
          <span className="truncate">Принять</span>
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          className="min-w-0 flex-1"
          onClick={() =>
            void run(() => declineIncomingFriendRequest(token!, user._id))
          }
        >
          <XIcon data-icon="inline-start" />
          <span className="truncate">Отклонить</span>
        </Button>
      </div>
    )
  }

  if (user.relationship === 'None') {
    return (
      <div className={cn('flex gap-1.5', className)}>
        <Button
          type="button"
          size="sm"
          disabled={disabled}
          className="min-w-0 flex-1"
          onClick={() => void run(() => sendFriendRequestToUser(token!, user))}
        >
          {pendingIcon ?? <UserPlusIcon data-icon="inline-start" />}
          <span className="truncate">Добавить в друзья</span>
        </Button>
      </div>
    )
  }

  if (user.relationship === 'Outgoing') {
    return (
      <div className={cn('flex gap-1.5', className)}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          className="min-w-0 flex-1"
          onClick={() =>
            void run(() => cancelOutgoingFriendRequest(token!, user._id))
          }
        >
          {pendingIcon ?? <XIcon data-icon="inline-start" />}
          <span className="truncate">Отменить заявку</span>
        </Button>
      </div>
    )
  }

  if (user.relationship === 'Friend') {
    return (
      <div className={cn('flex gap-1.5', className)}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          className="min-w-0 flex-1"
          onClick={() => void run(() => removeFriend(token!, user._id))}
        >
          {pendingIcon ?? <UserMinusIcon data-icon="inline-start" />}
          <span className="truncate">Удалить из друзей</span>
        </Button>
      </div>
    )
  }

  if (user.relationship === 'Blocked') {
    return (
      <div className={cn('flex gap-1.5', className)}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          className="min-w-0 flex-1"
          onClick={() => void run(() => unblockBlockedUser(token!, user._id))}
        >
          {pendingIcon ?? <ShieldOffIcon data-icon="inline-start" />}
          <span className="truncate">Разблокировать</span>
        </Button>
      </div>
    )
  }

  return null
}

export function FriendshipContextMenuItems({ user }: { user: User }) {
  const auth = useAuth()
  const token = auth.session?.token
  const [busy, setBusy] = useState(false)

  if (shouldHideFriendshipAction(user, auth.user?._id)) return null

  async function run(action: () => Promise<unknown>) {
    if (!token || busy) return
    setBusy(true)
    try {
      await action()
    } catch {
      // friend-actions already shows the concrete error toast.
    } finally {
      setBusy(false)
    }
  }

  const disabled = busy || !token

  if (user.relationship === 'Incoming') {
    return (
      <>
        <ContextMenuItem
          disabled={disabled}
          onSelect={() =>
            void run(() => acceptIncomingFriendRequest(token!, user._id))
          }
        >
          <UserCheckIcon />
          Принять заявку
        </ContextMenuItem>
        <ContextMenuItem
          disabled={disabled}
          onSelect={() =>
            void run(() => declineIncomingFriendRequest(token!, user._id))
          }
        >
          <XIcon />
          Отклонить заявку
        </ContextMenuItem>
      </>
    )
  }

  if (user.relationship === 'None') {
    return (
      <ContextMenuItem
        disabled={disabled}
        onSelect={() => void run(() => sendFriendRequestToUser(token!, user))}
      >
        <UserPlusIcon />
        Добавить в друзья
      </ContextMenuItem>
    )
  }

  if (user.relationship === 'Outgoing') {
    return (
      <ContextMenuItem
        disabled={disabled}
        onSelect={() =>
          void run(() => cancelOutgoingFriendRequest(token!, user._id))
        }
      >
        <XIcon />
        Отменить заявку
      </ContextMenuItem>
    )
  }

  if (user.relationship === 'Friend') {
    return (
      <ContextMenuItem
        disabled={disabled}
        variant="destructive"
        onSelect={() => void run(() => removeFriend(token!, user._id))}
      >
        <UserMinusIcon />
        Удалить из друзей
      </ContextMenuItem>
    )
  }

  if (user.relationship === 'Blocked') {
    return (
      <ContextMenuItem
        disabled={disabled}
        onSelect={() => void run(() => unblockBlockedUser(token!, user._id))}
      >
        <ShieldOffIcon />
        Разблокировать
      </ContextMenuItem>
    )
  }

  return null
}
