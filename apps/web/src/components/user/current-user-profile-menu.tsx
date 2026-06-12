import { useQuery } from '@tanstack/react-query'
import { PencilFillIcon } from '#/components/icons'
import type { User } from '@syrnike13/api-types'

import { FxImage } from '#/components/ui/fx-image'
import { UserAvatar } from '#/components/user/user-avatar'
import { UserProfileStatusBubble } from '#/components/user/user-profile-status-bubble'
import {
  profileMenuNestClass,
  profileMenuRowClass,
} from '#/components/user/profile-menu-row'
import { PresenceStatusSelect } from '#/components/user/presence-status-select'
import { useAuth } from '#/features/auth/auth-context'
import { fetchUserProfile } from '#/features/api/users-api'
import { queryKeys } from '#/lib/api/query-keys'
import { userBannerUrl } from '#/lib/media'
import { userProfileBannerClassName } from '#/lib/user-profile-banner'
import { useSettingsModal } from '#/features/settings/settings-modal-context'
import { cn } from '#/lib/utils'

type CurrentUserProfileMenuProps = {
  user: User
  onClose?: () => void
  onOpenGlobalProfile?: () => void
}

/** Поповер панели пользователя — отдельная вёрстка, не общая карточка чужого профиля. */
export function CurrentUserProfileMenu({
  user,
  onClose,
  onOpenGlobalProfile,
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

  const bannerUrl = userBannerUrl(profileQuery.data?.background, {
    animated: true,
  })
  const profileBio = profileQuery.data?.content?.trim()

  return (
    <div className="flex min-w-0 flex-col">
      <div className="relative">
        <div
          className={userProfileBannerClassName(
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
        <div className="absolute -bottom-7 left-3 z-10">
          <UserProfileStatusBubble
            status={customStatus}
            className="left-full top-[52%] ml-2"
          />
          <button
            type="button"
            title="Открыть профиль"
            aria-label="Открыть профиль"
            className="group/avatar-button cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0"
            onClick={(event) => {
              event.stopPropagation()
              onOpenGlobalProfile?.()
            }}
          >
            <span className="relative block rounded-full">
              <UserAvatar
                user={user}
                className="size-20"
                fallbackClassName="size-20 text-xl ring-[6px] ring-card bg-card"
                animated="always"
                showPresence
                presenceRingClassName="border-card"
              />
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 rounded-full bg-black/0 transition-colors group-hover/avatar-button:bg-black/25"
              />
            </span>
          </button>
        </div>
      </div>

      <div className="px-3 pt-10 pb-3">
        <h2 className="truncate text-lg font-semibold leading-snug text-foreground">
          {displayName}
        </h2>
        <p className="mt-0.5 truncate text-sm leading-snug text-muted-foreground">
          {user.display_name ? `@${user.username}` : user.username}
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
          <PencilFillIcon
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
