import type { User } from '@syrnike13/api-types'

import { Avatar, AvatarFallback, AvatarImage } from '#/components/ui/avatar'
import { userAvatarUrl } from '#/lib/media'
import { isUserOnline } from '#/lib/presence'
import { cn } from '#/lib/utils'

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

type UserAvatarProps = {
  user?: User | null
  className?: string
  fallbackClassName?: string
  showPresence?: boolean
  /** Кольцо вокруг точки статуса (фон под аватаром) */
  presenceRingClassName?: string
  presenceClassName?: string
}

export function UserAvatar({
  user,
  className,
  fallbackClassName,
  showPresence = true,
  presenceRingClassName = 'border-card',
  presenceClassName,
}: UserAvatarProps) {
  const name = user?.display_name ?? user?.username ?? '?'
  const online = isUserOnline(user)
  const showDot = showPresence && user && user.relationship !== 'Blocked'
  const avatarSrc = user ? userAvatarUrl(user.avatar) : null

  return (
    <div className={cn('relative shrink-0', className)}>
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
            online ? 'bg-chart-3' : 'bg-muted-foreground',
            presenceClassName,
          )}
          title={online ? 'В сети' : 'Не в сети'}
        />
      ) : null}
    </div>
  )
}
