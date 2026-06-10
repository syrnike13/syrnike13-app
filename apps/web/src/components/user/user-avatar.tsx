import type { User } from '@syrnike13/api-types'
import { useState } from 'react'

import { Avatar, AvatarFallback, AvatarImage } from '#/components/ui/avatar'
import { userAvatarUrl } from '#/lib/media'
import { presenceDotClass, presenceDotTitle } from '#/lib/presence'
import { cn } from '#/lib/utils'

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

export type UserAvatarAnimationMode = 'never' | 'hover' | 'always' | 'speaking'

type UserAvatarProps = {
  user?: User | null
  className?: string
  fallbackClassName?: string
  showPresence?: boolean
  animated?: UserAvatarAnimationMode
  speaking?: boolean
  /** Кольцо вокруг точки статуса (фон под аватаром) */
  presenceRingClassName?: string
  presenceClassName?: string
}

export function UserAvatar({
  user,
  className,
  fallbackClassName,
  showPresence = true,
  animated = 'hover',
  speaking = false,
  presenceRingClassName = 'border-card',
  presenceClassName,
}: UserAvatarProps) {
  const [hoverAnimationRequested, setHoverAnimationRequested] = useState(false)
  const name = user?.display_name ?? user?.username ?? '?'
  const showDot = showPresence && user && user.relationship !== 'Blocked'
  const shouldAnimate =
    animated === 'always' ||
    (animated === 'hover' && hoverAnimationRequested) ||
    (animated === 'speaking' && speaking)
  const avatarSrc = user
    ? userAvatarUrl(user.avatar, { animated: shouldAnimate })
    : null

  return (
    <div
      className={cn('relative shrink-0', className)}
      onPointerEnter={
        animated === 'hover'
          ? () => setHoverAnimationRequested(true)
          : undefined
      }
      onFocus={
        animated === 'hover'
          ? () => setHoverAnimationRequested(true)
          : undefined
      }
    >
      <Avatar className={fallbackClassName}>
        {avatarSrc ? (
          <AvatarImage src={avatarSrc} alt={name} className="object-cover" />
        ) : null}
        <AvatarFallback>{initials(name)}</AvatarFallback>
      </Avatar>
      {showDot ? (
        <span
          className={cn(
            'absolute right-0 bottom-0 z-10 size-3 translate-x-[22%] translate-y-[22%] rounded-full border-2',
            presenceRingClassName,
            presenceDotClass(user),
            presenceClassName,
          )}
          title={presenceDotTitle(user)}
        />
      ) : null}
    </div>
  )
}
