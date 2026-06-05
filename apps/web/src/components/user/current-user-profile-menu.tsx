import { useQuery } from '@tanstack/react-query'
import { PencilIcon } from 'lucide-react'
import type { User } from '@syrnike13/api-types'

import { FxImage } from '#/components/ui/fx-image'
import { UserAvatar } from '#/components/user/user-avatar'
import {
  profileMenuNestClass,
  profileMenuRowClass,
} from '#/components/user/profile-menu-row'
import { PresenceStatusSelect } from '#/components/user/presence-status-select'
import { useAuth } from '#/features/auth/auth-context'
import { fetchUserProfile } from '#/features/api/users-api'
import { queryKeys } from '#/lib/api/query-keys'
import { userBannerUrl } from '#/lib/media'
import { useSettingsModal } from '#/features/settings/settings-modal-context'
import { cn } from '#/lib/utils'

type CurrentUserProfileMenuProps = {
  user: User
  onClose?: () => void
}

/** Поповер панели пользователя — отдельная вёрстка, не общая карточка чужого профиля. */
export function CurrentUserProfileMenu({
  user,
  onClose,
}: CurrentUserProfileMenuProps) {
  const auth = useAuth()
  const { openSettings } = useSettingsModal()
  const token = auth.session?.token
  const displayName = user.display_name ?? user.username
  const customStatus = user.status?.text?.trim()

  const profileQuery = useQuery({
    queryKey: queryKeys.users.profile(user._id),
    queryFn: () => fetchUserProfile(token!, user._id),
    enabled: Boolean(token),
    staleTime: 60_000,
  })

  const bannerUrl = userBannerUrl(profileQuery.data?.background)
  const profileBio = profileQuery.data?.content?.trim()

  return (
    <div className="flex min-w-0 flex-col">
      <div className="relative">
        <div
          className={cn(
            'relative h-14 w-full overflow-hidden',
            !bannerUrl &&
              'bg-gradient-to-br from-primary/80 via-chart-4/70 to-sidebar-primary/80',
          )}
        >
          {bannerUrl ? (
            <>
              <FxImage
                src={bannerUrl}
                wrapperClassName="block h-full w-full"
                className="h-full w-full"
              />
              <div
                className="pointer-events-none absolute inset-0 z-[1] bg-background/40"
                aria-hidden
              />
            </>
          ) : null}
        </div>
        <div className="absolute -bottom-5 left-3">
          <UserAvatar
            user={user}
            className="size-12"
            fallbackClassName="size-12 text-sm ring-4 ring-card"
            showPresence
            presenceRingClassName="border-card"
            presenceClassName="size-4 translate-x-[16%] translate-y-[16%] border-2"
          />
        </div>
      </div>

      <div className="px-3 pt-7 pb-3">
        <h2 className="truncate text-lg font-semibold leading-snug text-foreground">
          {displayName}
        </h2>
        <p className="mt-0.5 truncate text-sm leading-snug text-muted-foreground">
          {user.display_name ? `@${user.username}` : user.username}
          {customStatus ? (
            <>
              <span className="text-muted-foreground/50"> · </span>
              <span className="text-foreground/80">{customStatus}</span>
            </>
          ) : null}
        </p>
        {profileBio ? (
          <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
            {profileBio}
          </p>
        ) : null}
      </div>

      <div className={profileMenuNestClass}>
        <button
          type="button"
          className={profileMenuRowClass}
          onClick={() => {
            onClose?.()
            openSettings('profile')
          }}
        >
          <PencilIcon
            className="size-4 shrink-0 opacity-75 transition-opacity group-hover:opacity-100"
            aria-hidden
          />
          <span className="truncate">Редактировать профиль</span>
        </button>
        <PresenceStatusSelect />
      </div>
    </div>
  )
}
