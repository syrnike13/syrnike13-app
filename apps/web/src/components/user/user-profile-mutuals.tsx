import type { User } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from '@syrnike13/ui/primitives/avatar'
import { userAvatarUrl } from '#/lib/media'
import { cn } from '#/lib/utils'

type UserProfileMutualsProps = {
  mutualFriends: User[]
  mutualFriendsCount: number
  mutualServersCount: number
  className?: string
}

/** Строка общих друзей/серверов в поповере профиля. */
export function UserProfileMutuals({
  mutualFriends,
  mutualFriendsCount,
  mutualServersCount,
  className,
}: UserProfileMutualsProps) {
  const t = useTranslations('users')
  if (mutualFriendsCount === 0 && mutualServersCount === 0) return null

  const avatars = mutualFriends.slice(0, 3)

  return (
    <div
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 py-1 text-xs leading-4 text-muted-foreground',
        className,
      )}
    >
      {avatars.length > 0 ? (
        <div className="flex shrink-0 items-center" aria-hidden>
          {avatars.map((friend, index) => (
            <Avatar
              key={friend._id}
              className={cn('size-4', index > 0 && '-ml-1')}
            >
              {userAvatarUrl(friend.avatar, { animated: false }) ? (
                <AvatarImage
                  src={userAvatarUrl(friend.avatar, { animated: false })!}
                  alt=""
                  className="object-cover"
                />
              ) : null}
              <AvatarFallback className="text-xs">
                {(friend.display_name ?? friend.username).slice(0, 1)}
              </AvatarFallback>
            </Avatar>
          ))}
        </div>
      ) : null}

      {mutualFriendsCount > 0 ? (
        <span className="truncate">
          {t('mutualFriendsCount', { count: mutualFriendsCount })}
        </span>
      ) : null}

      {mutualFriendsCount > 0 && mutualServersCount > 0 ? (
        <span
          aria-hidden
          className="size-1 shrink-0 rounded-full bg-muted-foreground/50"
        />
      ) : null}

      {mutualServersCount > 0 ? (
        <span className="truncate">
          {t('mutualServersCount', { count: mutualServersCount })}
        </span>
      ) : null}
    </div>
  )
}
