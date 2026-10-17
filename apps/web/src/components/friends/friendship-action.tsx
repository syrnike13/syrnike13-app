import type { User } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Effect } from 'effect'
import { useState } from 'react'

import {
  Loader2Icon,
  ShieldOffIcon,
  UserCheckIcon,
  UserMinusIcon,
  UserPlusIcon,
  XIcon,
} from '#/components/icons'
import { Button } from '@syrnike13/ui/primitives/button'
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
            void run(() => acceptIncomingFriendRequest(token!, user._id, t))
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
            void run(() => declineIncomingFriendRequest(token!, user._id, t))
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
          onClick={() => void run(() => sendFriendRequestToUser(token!, user, t))}
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
            void run(() => cancelOutgoingFriendRequest(token!, user._id, t))
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
          onClick={() => void run(() => removeFriend(token!, user._id, t))}
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
          onClick={() => void run(() => unblockBlockedUser(token!, user._id, t))}
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
          onSelect={() =>
            void run(() => acceptIncomingFriendRequest(token!, user._id, t))
          }
        >
          <UserCheckIcon />
          {t('acceptRequest')}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={disabled}
          onSelect={() =>
            void run(() => declineIncomingFriendRequest(token!, user._id, t))
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
        onSelect={() => void run(() => sendFriendRequestToUser(token!, user, t))}
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
        onSelect={() =>
          void run(() => cancelOutgoingFriendRequest(token!, user._id, t))
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
        onSelect={() => void run(() => removeFriend(token!, user._id, t))}
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
        onSelect={() => void run(() => unblockBlockedUser(token!, user._id, t))}
      >
        <ShieldOffIcon />
        {t('unblock')}
      </ContextMenuItem>
    )
  }

  return null
}
