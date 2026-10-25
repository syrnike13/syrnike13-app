import { createContext, useContext, useState, type ReactNode } from 'react'
import type { ProfileColours, User } from '@syrnike13/api-types'
import { useTranslations } from '@syrnike13/ui/i18n'

import { PencilFillIcon } from '#/components/icons'
import { FxImage } from '#/components/ui/fx-image'
import { UserAvatar } from '#/components/user/user-avatar'
import { UserBadges } from '#/components/user/user-badges'
import { UserProfileStatusBubble } from '#/components/user/user-profile-status-bubble'
import { useUserProfileData } from '#/components/user/use-user-profile-data'
import { useUserBadges } from '#/features/users/use-user-badges'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'

/**
 * Building blocks of every profile surface: the member popover, the own
 * profile menu, the DM side panel and the full profile dialog. The surface
 * colour is one CSS variable, so the avatar cut-out, the presence ring and the
 * status bubble always match the card they sit on.
 *
 * Geometry (Discord): `sm` — banner 105px, avatar 80px at 16/61px;
 * `lg` — banner 140px, avatar 120px at 32/80px.
 */
type ProfileSize = 'sm' | 'lg'
type ProfileSurfaceColor = 'popover' | 'card' | 'secondary'

const ProfileSizeContext = createContext<ProfileSize>('sm')

const SURFACE_VAR: Record<ProfileSurfaceColor, string> = {
  popover: 'var(--popover)',
  card: 'var(--card)',
  secondary: 'var(--secondary)',
}

export function ProfileSurface({
  size = 'sm',
  surface,
  colours,
  className,
  children,
}: {
  size?: ProfileSize
  surface: ProfileSurfaceColor
  /** Profile theme; the card keeps its plain surface without one. */
  colours?: ProfileColours | null
  className?: string
  children: ReactNode
}) {
  return (
    <ProfileSizeContext.Provider value={size}>
      <div
        data-profile-size={size}
        className={cn(
          'relative flex min-w-0 flex-col',
          colours && 'profile-theme',
          className,
        )}
        // Profile colours come from the API, like role colours.
        style={
          colours
            ? ({
                '--profile-base': SURFACE_VAR[surface],
                '--profile-primary': colours.primary,
                '--profile-accent': colours.accent,
              } as CSSVars)
            : ({ '--profile-surface': SURFACE_VAR[surface] } as CSSVars)
        }
      >
        {children}
      </div>
    </ProfileSizeContext.Provider>
  )
}

/**
 * Banner, avatar with the surface cut-out, presence and custom status.
 * `actions` sit in the banner's top-right corner.
 */
export function ProfileHeader({
  user,
  actions,
  onAvatarClick,
  avatarLabel,
  onStatusClick,
  bannerSrc,
  avatarSrc,
  onBannerClick,
  bannerLabel,
  editable = false,
}: {
  user: User
  /** Profile settings: clicking the banner picks a new one. */
  onBannerClick?: () => void
  bannerLabel?: string
  /** Show a pencil over the avatar and banner on hover. */
  editable?: boolean
  /** Preview (profile settings): unsaved banner; null shows the gradient. */
  bannerSrc?: string | null
  /** Preview (profile settings): unsaved avatar. */
  avatarSrc?: string | null
  actions?: ReactNode
  onAvatarClick?: () => void
  avatarLabel?: string
  /** Own profile: the status bubble edits the custom status. */
  onStatusClick?: () => void
}) {
  const size = useContext(ProfileSizeContext)
  const lg = size === 'lg'
  const t = useTranslations('users')
  const { bannerUrl: savedBannerUrl } = useUserProfileData(user._id)
  const bannerUrl = bannerSrc !== undefined ? bannerSrc : savedBannerUrl
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const showBanner = bannerUrl != null && failedUrl !== bannerUrl
  const status = user.status?.text?.trim()

  const avatar = (
    <UserAvatar
      user={avatarSrc === null ? { ...user, avatar: null } : user}
      imageSrc={avatarSrc ?? undefined}
      className={lg ? 'size-30' : 'size-20'}
      fallbackClassName={lg ? 'size-30 text-3xl' : 'size-20 text-xl'}
      animated="always"
      showPresence
    />
  )

  return (
    <div className={cn('relative shrink-0', lg ? 'h-55' : 'h-38')}>
      <div
        className={cn(
          'group/banner relative w-full overflow-hidden',
          lg ? 'h-35' : 'h-26.25',
          !showBanner &&
            'bg-linear-to-br from-primary via-chart-4 to-sidebar-primary',
        )}
      >
        {showBanner ? (
          <>
            <FxImage
              src={bannerUrl}
              wrapperClassName="block size-full"
              className="size-full object-cover"
              onError={() => setFailedUrl(bannerUrl)}
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 bg-media-backdrop/20"
            />
          </>
        ) : null}
        {onBannerClick ? (
          // eslint-disable-next-line design/no-lookalike -- banner image is the edit target
          <button
            type="button"
            title={bannerLabel}
            aria-label={bannerLabel}
            className="absolute inset-0 flex cursor-pointer items-center justify-center bg-media-backdrop/0 text-on-media transition-colors outline-none hover:bg-media-backdrop/40 focus-visible:bg-media-backdrop/40"
            onClick={onBannerClick}
          >
            {editable ? (
              <PencilFillIcon
                aria-hidden
                className="size-5 opacity-0 transition-opacity group-hover/banner:opacity-100"
              />
            ) : null}
          </button>
        ) : null}
      </div>

      {actions ? (
        <div className="absolute top-2 right-2 z-20 flex items-center gap-2">
          {actions}
        </div>
      ) : null}

      <div
        className={cn(
          'absolute z-10 rounded-full bg-(--profile-surface)',
          lg ? 'top-18.5 left-6.5 p-1.5' : 'top-13.75 left-2.5 p-1.5',
        )}
      >
        {onAvatarClick ? (
          // eslint-disable-next-line design/no-lookalike -- avatar image is the edit target
          <button
            type="button"
            title={avatarLabel ?? t('openProfile')}
            aria-label={avatarLabel ?? t('openProfile')}
            className="group/avatar relative block rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(event) => {
              event.stopPropagation()
              onAvatarClick()
            }}
          >
            {avatar}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-full bg-media-backdrop/0 text-on-media transition-colors group-hover/avatar:bg-media-backdrop/40"
            >
              {editable ? (
                <PencilFillIcon className="size-5 opacity-0 transition-opacity group-hover/avatar:opacity-100" />
              ) : null}
            </span>
          </button>
        ) : (
          avatar
        )}
        <UserProfileStatusBubble
          status={status}
          onClick={onStatusClick}
          placeholder={t('addStatus')}
          className={cn('left-full ml-1', lg ? 'top-1/3' : 'top-1/4')}
        />
      </div>
    </div>
  )
}

/** Padded column under the header. */
export function ProfileBody({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  const size = useContext(ProfileSizeContext)
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col',
        size === 'lg' ? 'gap-6 px-8 pt-1 pb-8' : 'gap-3 px-4 pt-1 pb-4',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** Display name (20/24 or 24/32 w600), username and badges. */
export function ProfileName({
  user,
  nameSlot,
}: {
  user: User
  /** Replaces the plain name, e.g. with a status picker trigger. */
  nameSlot?: ReactNode
}) {
  const size = useContext(ProfileSizeContext)
  const badges = useUserBadges(user._id, user.badges)
  const displayName = user.display_name ?? user.username

  return (
    <div className="min-w-0">
      {nameSlot ?? (
        <h2
          className={cn(
            'truncate font-semibold text-foreground',
            size === 'lg' ? 'text-2xl leading-8' : 'text-xl leading-6',
          )}
        >
          {displayName}
        </h2>
      )}
      <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
        <p className="min-w-0 truncate text-sm leading-4.5 text-foreground">
          {user.username}
        </p>
        <UserBadges badges={badges} size="sm" className="shrink-0 flex-nowrap" />
      </div>
    </div>
  )
}

/** Titled block: 12/16 w600 heading, 14/18 content. */
export function ProfileSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      <h3 className="text-xs leading-4 font-semibold text-foreground">{title}</h3>
      <div className="min-w-0 text-sm leading-4.5 text-foreground">{children}</div>
    </section>
  )
}
