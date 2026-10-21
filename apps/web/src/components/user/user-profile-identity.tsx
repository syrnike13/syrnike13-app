import type { User } from '@syrnike13/api-types'

import { UserBadges } from '#/components/user/user-badges'
import { useUserBadges } from '#/features/users/use-user-badges'
import { cn } from '#/lib/utils'

type UserProfileIdentityProps = {
  user: User
  variant?: 'popover' | 'panel' | 'modal'
  className?: string
}

export function UserProfileIdentity({
  user,
  variant = 'popover',
  className,
}: UserProfileIdentityProps) {
  const displayName = user.display_name ?? user.username
  const username = user.display_name ? `@${user.username}` : user.username
  const badges = useUserBadges(user._id, user.badges)
  const modal = variant === 'modal'

  return (
    <div className={cn('min-w-0', className)}>
      <h2
        className={cn(
          'truncate font-semibold text-foreground',
          modal ? 'text-2xl leading-8' : 'text-xl leading-6',
        )}
      >
        {displayName}
      </h2>
      <div className="mt-1 flex min-w-0 items-center gap-1.5">
        <p className="min-w-0 truncate text-sm leading-4.5 text-muted-foreground">
          {username}
        </p>
        <UserBadges badges={badges} size="sm" className="shrink-0 flex-nowrap" />
      </div>
    </div>
  )
}
