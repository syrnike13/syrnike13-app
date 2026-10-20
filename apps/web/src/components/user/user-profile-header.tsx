import type { ReactNode } from 'react'
import type { User } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'

import { FxImage } from '#/components/ui/fx-image'
import { UserAvatar } from '#/components/user/user-avatar'
import { UserProfileStatusBubble } from '#/components/user/user-profile-status-bubble'
import { useUserProfileData } from '#/components/user/use-user-profile-data'
import { userProfileBannerClassName } from '#/lib/user-profile-banner'
import { cn } from '#/lib/utils'

export type UserProfileHeaderVariant = 'popover' | 'panel' | 'modal'

type UserProfileHeaderProps = {
  user: User
  variant?: UserProfileHeaderVariant
  /** Кнопки в правом верхнем углу баннера. */
  bannerActions?: ReactNode
  /** Клик по аватару открывает полный профиль. */
  onAvatarClick?: () => void
  className?: string
}

/**
 * Баннер и аватар профиля. Геометрия:
 * поповер/панель — баннер 105px, аватар 80px; модалка — 140px и 120px.
 */
export function UserProfileHeader({
  user,
  variant = 'popover',
  bannerActions,
  onAvatarClick,
  className,
}: UserProfileHeaderProps) {
  const t = useTranslations('users')
  const { bannerUrl } = useUserProfileData(user._id)
  const customStatus = user.status?.text?.trim()
  const modal = variant === 'modal'

  const avatar = (
    <UserAvatar
      user={user}
      className={modal ? 'size-30' : 'size-20'}
      fallbackClassName={cn(
        modal ? 'size-30 text-3xl ring-6' : 'size-20 text-xl ring-6',
        variant === 'modal'
          ? 'ring-secondary bg-secondary'
          : variant === 'panel'
            ? 'ring-card bg-card'
            : 'ring-popover bg-muted',
      )}
      animated="always"
      showPresence
      presenceRingClassName={
        variant === 'modal'
          ? 'border-secondary'
          : variant === 'panel'
            ? 'border-card'
            : 'border-popover'
      }
    />
  )

  return (
    <div className={cn('relative shrink-0', modal ? 'h-55' : 'h-38', className)}>
      <div
        className={userProfileBannerClassName(
          modal ? 'h-35 rounded-t-xl' : 'rounded-t-lg',
          !bannerUrl &&
            'bg-gradient-to-br from-primary via-chart-4 to-sidebar-primary',
        )}
      >
        {bannerUrl ? (
          <>
            <FxImage
              src={bannerUrl}
              wrapperClassName="block h-full w-full"
              className="h-full w-full object-cover"
            />
            <div
              className="pointer-events-none absolute inset-0 z-1 bg-media-backdrop/20"
              aria-hidden
            />
          </>
        ) : null}
      </div>

      {bannerActions ? (
        <div className="absolute top-2 right-2 z-20 flex items-center gap-2">
          {bannerActions}
        </div>
      ) : null}

      <div
        className={cn(
          'absolute z-10',
          modal ? 'top-20 left-8' : 'top-15.25 left-4',
        )}
      >
        <UserProfileStatusBubble
          status={customStatus}
          className={cn(
            'left-full',
            modal ? 'top-1/2 ml-2' : 'top-46/100 ml-2.5',
          )}
        />
        {onAvatarClick ? (
          <button
            type="button"
            title={t('openProfile')}
            aria-label={t('openProfile')}
            className="group/avatar-button cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0"
            onClick={(event) => {
              event.stopPropagation()
              onAvatarClick()
            }}
          >
            <span className="relative block rounded-full">
              {avatar}
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 rounded-full bg-media-backdrop/0 transition-colors group-hover/avatar-button:bg-media-backdrop/25"
              />
            </span>
          </button>
        ) : (
          avatar
        )}
      </div>
    </div>
  )
}
