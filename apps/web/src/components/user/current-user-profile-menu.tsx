import { useQuery } from '@tanstack/react-query'
import { useTranslations } from '@syrnike13/ui/i18n'
import { PencilFillIcon, ChevronDownIcon, SettingsIcon } from '#/components/icons'
import { useNavigate } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import type { User } from '@syrnike13/api-types'

import { FxImage } from '#/components/ui/fx-image'
import { Button } from '@syrnike13/ui/primitives/button'
import { UserAvatar } from '#/components/user/user-avatar'
import { UserBadges } from '#/components/user/user-badges'
import { UserProfileStatusBubble } from '#/components/user/user-profile-status-bubble'
import {
  profileMenuNestClass,
  profileMenuRowClass,
} from '#/components/user/profile-menu-row'
import { PresenceStatusSelect } from '#/components/user/presence-status-select'
import { useAuth } from '#/features/auth/auth-context'
import { canAccessAdmin } from '#/features/authorization/authorization'
import { fetchUserProfile } from '#/features/api/users-api'
import { queryKeys } from '#/lib/api/query-keys'
import { userBannerUrl } from '#/lib/media'
import { userProfileBannerClassName } from '#/lib/user-profile-banner'
import { useSettingsModal } from '#/features/settings/settings-modal-context'

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
  const t = useTranslations('users')
  const auth = useAuth()
  const navigate = useNavigate()
  const { openSettings } = useSettingsModal()
  const token = auth.session?.token
  const displayName = user.display_name ?? user.username
  const customStatus = user.status?.text?.trim()

  const profileQuery = useQuery({
    queryKey: queryKeys.users.profile(user._id),
    queryFn: ({ signal }) => fetchUserProfile(token!, user._id, signal),
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
          <div className="absolute inset-x-0 top-0 z-20 flex items-center justify-between px-3 safe-pt-3">
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
                className="pointer-events-none absolute inset-0 z-1 bg-background/40"
                aria-hidden
              />
            </>
          ) : null}
        </div>
        <div className="absolute top-15.25 left-4 z-10">
          <UserProfileStatusBubble
            status={customStatus}
            className="left-full top-46/100 ml-2.5"
          />
          <button
            type="button"
            title={onAvatarPress ? t('selectStatus') : t('openProfile')}
            aria-label={onAvatarPress ? t('selectStatus') : t('openProfile')}
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
                fallbackClassName="size-20 text-xl ring-6 ring-popover bg-card"
                animated="always"
                showPresence
                presenceRingClassName="border-popover"
              />
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 rounded-full bg-media-backdrop/0 transition-colors group-hover/avatar-button:bg-media-backdrop/25"
              />
            </span>
          </button>
        </div>
      </div>

      <div className="px-4 pt-15 pb-3">
        {onAvatarPress ? (
          <button
            type="button"
            title={t('selectStatus')}
            aria-label={t('selectStatus')}
            className="group/display-name flex w-full min-w-0 items-center gap-0.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onAvatarPress}
          >
            <span className="truncate text-xl leading-6 font-semibold text-foreground">
              {displayName}
            </span>
            <ChevronDownIcon
              className="size-4 shrink-0 opacity-50 transition-opacity group-hover/display-name:opacity-80"
              aria-hidden
            />
          </button>
        ) : (
          <h2 className="truncate text-xl leading-6 font-semibold text-foreground">
            {displayName}
          </h2>
        )}
        <p className="mt-0.5 truncate text-sm leading-4.5 text-muted-foreground">
          {user.display_name ? `@${user.username}` : user.username}
        </p>
        <UserBadges badges={user.badges} size="sm" className="mt-2" />
        {profileBio ? (
          <p className="mt-2 line-clamp-2 text-sm leading-4.5 text-muted-foreground">
            {profileBio}
          </p>
        ) : null}
      </div>

      {hidePresenceRow ? (
        <div className="px-3 pb-3">
          <Button
            type="button"
            className="h-8 w-full"
            onClick={() => openSettings('profile')}
          >
            <PencilFillIcon className="size-4" aria-hidden />
            {t('editProfile')}
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
            <span className="truncate">{t('editProfile')}</span>
          </button>
          {canAccessAdmin() ? (
            <button
              type="button"
              className={profileMenuRowClass}
              onClick={() => {
                onClose?.()
                void navigate({ to: '/admin' })
              }}
            >
              <SettingsIcon
                className="size-4 shrink-0 opacity-75 transition-opacity group-hover:opacity-100"
                aria-hidden
              />
              <span className="truncate">{t('admin')}</span>
            </button>
          ) : null}
          <PresenceStatusSelect />
        </div>
      )}
    </div>
  )
}
