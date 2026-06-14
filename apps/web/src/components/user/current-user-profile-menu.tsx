import { useQuery } from '@tanstack/react-query'
import { PencilFillIcon, ChevronDownIcon } from '#/components/icons'
import type { ReactNode } from 'react'
import type { User } from '@syrnike13/api-types'

import { FxImage } from '#/components/ui/fx-image'
import { Button } from '#/components/ui/button'
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
  /** По тапу на аватар (например, drawer статуса на мобильной странице профиля). */
  onAvatarPress?: () => void
  /** Скрыть строку выбора presence в меню (если статус открывается с аватара). */
  hidePresenceRow?: boolean
  /** Кнопки поверх баннера (например, закрыть на мобильной странице профиля). */
  bannerOverlay?: ReactNode
}

/** Поповер панели пользователя — отдельная вёрстка, не общая карточка чужого профиля. */
export function CurrentUserProfileMenu({
  user,
  onClose,
  onOpenGlobalProfile,
  onAvatarPress,
  hidePresenceRow = false,
  bannerOverlay,
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
        {bannerOverlay ? (
          <div className="absolute inset-x-0 top-0 z-20 flex items-center justify-between px-3 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)]">
            {bannerOverlay}
          </div>
        ) : null}
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
            title={onAvatarPress ? 'Выбрать статус' : 'Открыть профиль'}
            aria-label={onAvatarPress ? 'Выбрать статус' : 'Открыть профиль'}
            className="group/avatar-button cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0"
            onClick={(event) => {
              event.stopPropagation()
              if (onAvatarPress) {
                onAvatarPress()
                return
              }
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
        {onAvatarPress ? (
          <button
            type="button"
            title="Выбрать статус"
            aria-label="Выбрать статус"
            className="group/display-name flex w-full min-w-0 items-center gap-0.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onAvatarPress}
          >
            <span className="truncate text-lg font-semibold leading-snug text-foreground">
              {displayName}
            </span>
            <ChevronDownIcon
              className="size-4 shrink-0 opacity-50 transition-opacity group-hover/display-name:opacity-80"
              aria-hidden
            />
          </button>
        ) : (
          <h2 className="truncate text-lg font-semibold leading-snug text-foreground">
            {displayName}
          </h2>
        )}
        <p className="mt-0.5 truncate text-sm leading-snug text-muted-foreground">
          {user.display_name ? `@${user.username}` : user.username}
        </p>
        {profileBio ? (
          <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
            {profileBio}
          </p>
        ) : null}
      </div>

      {hidePresenceRow ? (
        <div className="px-3 pb-3">
          <Button
            type="button"
            className="h-10 w-full rounded-full"
            onClick={() => openSettings('profile')}
          >
            <PencilFillIcon className="size-4" aria-hidden />
            Редактировать профиль
          </Button>
        </div>
      ) : (
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
      )}
    </div>
  )
}
