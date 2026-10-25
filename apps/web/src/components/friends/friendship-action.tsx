import type { User } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Effect } from 'effect'
import { useState } from 'react'

import {
  ShieldOffIcon,
  UserCheckIcon,
  UserMinusIcon,
  UserPlusIcon,
  XIcon,
} from '#/components/icons'
import { Button } from '@syrnike13/ui/primitives/button'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import { ContextMenuItem } from '@syrnike13/ui/primitives/context-menu'
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
  const t = useTranslations('friends')
  const auth = useAuth()
  const token = auth.session?.token
  const [busy, setBusy] = useState(false)

  if (shouldHideFriendshipAction(user, auth.user?._id)) return null

  async function run(action: () => Effect.Effect<unknown, unknown>) {
    if (!token || busy) return
    setBusy(true)
    try {
      await Effect.runPromise(action())
    } catch {
      // friend-actions already shows the concrete error toast.
    } finally {
      setBusy(false)
    }
  }

  const disabled = busy || !token
  const pendingIcon = busy ? (
    <Spinner className="size-4" data-icon="inline-start" />
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
          <span className="truncate">{t('accept')}</span>
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
          <span className="truncate">{t('decline')}</span>
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
          <span className="truncate">{t('add')}</span>
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
          <span className="truncate">{t('cancelRequest')}</span>
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
          <span className="truncate">{t('remove')}</span>
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
          <span className="truncate">{t('unblock')}</span>
        </Button>
      </div>
    )
  }

  return null
}

export function FriendshipContextMenuItems({ user }: { user: User }) {
  const t = useTranslations('friends')
  const auth = useAuth()
  const token = auth.session?.token
  const [busy, setBusy] = useState(false)

  if (shouldHideFriendshipAction(user, auth.user?._id)) return null

  async function run(action: () => Effect.Effect<unknown, unknown>) {
    if (!token || busy) return
    setBusy(true)
    try {
      await Effect.runPromise(action())
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
          onClick={() =>
            void run(() => acceptIncomingFriendRequest(token!, user._id))
          }
        >
          <UserCheckIcon />
          {t('acceptRequest')}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={disabled}
          onClick={() =>
            void run(() => declineIncomingFriendRequest(token!, user._id))
          }
        >
          <XIcon />
          {t('declineRequest')}
        </ContextMenuItem>
      </>
    )
  }

  if (user.relationship === 'None') {
    return (
      <ContextMenuItem
        disabled={disabled}
        onClick={() => void run(() => sendFriendRequestToUser(token!, user))}
      >
        <UserPlusIcon />
        {t('add')}
      </ContextMenuItem>
    )
  }

  if (user.relationship === 'Outgoing') {
    return (
      <ContextMenuItem
        disabled={disabled}
        onClick={() =>
          void run(() => cancelOutgoingFriendRequest(token!, user._id))
        }
      >
        <XIcon />
        {t('cancelRequest')}
      </ContextMenuItem>
    )
  }

  if (user.relationship === 'Friend') {
    return (
      <ContextMenuItem
        disabled={disabled}
        variant="destructive"
        onClick={() => void run(() => removeFriend(token!, user._id))}
      >
        <UserMinusIcon />
        {t('remove')}
      </ContextMenuItem>
    )
  }

  if (user.relationship === 'Blocked') {
    return (
      <ContextMenuItem
        disabled={disabled}
        onClick={() => void run(() => unblockBlockedUser(token!, user._id))}
      >
        <ShieldOffIcon />
        {t('unblock')}
      </ContextMenuItem>
    )
  }

  return null
}
