import type { User } from '@syrnike13/api-types'
import { useState } from 'react'

import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarImage,
} from '#/components/ui/avatar'
import type { NotificationBadgeState } from '#/features/notifications/notification-selectors'
import {
  presenceRingColorVar,
  resolvePresenceBadgeLayoutForAvatar,
} from '#/components/user/user-avatar-presence'
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

type AvatarCornerBadgeProps = {
  className?: string
  fallbackClassName?: string
  ringClassName?: string
}

type AvatarNotificationBadgeProps = AvatarCornerBadgeProps & {
  badge: NotificationBadgeState
  max?: number
}

export function AvatarNotificationBadge({
  badge,
  className,
  fallbackClassName,
  ringClassName = 'border-card',
  max = 99,
}: AvatarNotificationBadgeProps) {
  if (!badge.hasUnread && !badge.urgent) return null

  const layout = resolvePresenceBadgeLayoutForAvatar(className, fallbackClassName)
  const countLabel =
    badge.count > 0 ? `${badge.count} уведомлений` : 'Есть уведомления'
  const display = badge.count > max ? `${max}+` : String(badge.count || '!')

  return (
    <span
      aria-label={countLabel}
      title={countLabel}
      data-slot="avatar-badge"
      className={cn(
        'absolute right-0.5 bottom-0.5 z-10 grid place-items-center rounded-full select-none',
        'border-0 font-bold tabular-nums',
        layout.offsetClass,
        badge.count > 9 ? 'min-w-4 px-0.5' : 'aspect-square',
      )}
      style={{
        width: badge.count > 9 ? undefined : layout.sizePx,
        minWidth: layout.sizePx,
        height: layout.sizePx,
        fontSize: Math.round(layout.sizePx * 0.62),
        lineHeight: 1,
        backgroundColor: 'var(--destructive-contrast)',
        color: 'var(--destructive-foreground)',
        boxShadow: `0 0 0 ${layout.ringPx}px ${presenceRingColorVar(ringClassName)}`,
      }}
    >
      <span className="block translate-y-px leading-none">{display}</span>
    </span>
  )
}

type UserAvatarProps = {
  user?: User | null
  className?: string
  fallbackClassName?: string
  /** Прямой URL изображения (превью загрузки, анимированный GIF и т.п.) */
  imageSrc?: string | null
  showPresence?: boolean
  notificationBadge?: NotificationBadgeState
  animated?: UserAvatarAnimationMode
  speaking?: boolean
  /** Кольцо вокруг точки статуса (фон под аватаром) */
  presenceRingClassName?: string
  /** Кольцо вокруг бейджа уведомлений */
  notificationRingClassName?: string
}

export function UserAvatar({
  user,
  className,
  fallbackClassName,
  imageSrc,
  showPresence = true,
  notificationBadge,
  animated = 'hover',
  speaking = false,
  presenceRingClassName = 'border-card',
  notificationRingClassName = 'border-card',
}: UserAvatarProps) {
  const [hovered, setHovered] = useState(false)
  const [hoverAnimationRequested, setHoverAnimationRequested] = useState(false)
  const name = user?.display_name ?? user?.username ?? '?'
  const hasNotificationBadge = Boolean(
    notificationBadge?.hasUnread || notificationBadge?.urgent,
  )
  const showDot =
    showPresence && user && user.relationship !== 'Blocked' && !hasNotificationBadge
  const useImageSrcOverride = imageSrc != null

  const staticAvatarSrc = useImageSrcOverride
    ? imageSrc
    : user
      ? userAvatarUrl(user.avatar, { animated: false })
      : null
  const animatedAvatarSrc =
    useImageSrcOverride || !user
      ? null
      : userAvatarUrl(user.avatar, { animated: true })
  const hasAnimatedVariant =
    !useImageSrcOverride &&
    animatedAvatarSrc !== null &&
    animatedAvatarSrc !== staticAvatarSrc
  const showAnimatedOverlay =
    hasAnimatedVariant &&
    ((animated === 'hover' && hovered) || (animated === 'speaking' && speaking))
  const mountAnimatedOverlay =
    hasAnimatedVariant &&
    (animated === 'speaking' || (animated === 'hover' && hoverAnimationRequested))
  const avatarSrc =
    !useImageSrcOverride &&
    animated === 'always' &&
    hasAnimatedVariant
      ? animatedAvatarSrc
      : staticAvatarSrc
  const presenceBadge = resolvePresenceBadgeLayoutForAvatar(
    className,
    fallbackClassName,
  )

  function startHoverAnimation() {
    setHovered(true)
    setHoverAnimationRequested(true)
  }

  return (
    <div
      className={cn(
        'relative shrink-0',
        hasNotificationBadge && 'overflow-visible',
      )}
      onPointerEnter={
        animated === 'hover' && !useImageSrcOverride
          ? startHoverAnimation
          : undefined
      }
      onPointerLeave={
        animated === 'hover' && !useImageSrcOverride
          ? () => setHovered(false)
          : undefined
      }
      onFocus={
        animated === 'hover' && !useImageSrcOverride
          ? startHoverAnimation
          : undefined
      }
      onBlur={
        animated === 'hover' && !useImageSrcOverride
          ? () => setHovered(false)
          : undefined
      }
    >
      <Avatar className={cn(className, fallbackClassName)}>
        {avatarSrc ? (
          <AvatarImage
            src={avatarSrc}
            alt={name}
            className={cn(
              mountAnimatedOverlay && 'transition-opacity duration-150',
              showAnimatedOverlay && 'opacity-0',
            )}
          />
        ) : null}
        {mountAnimatedOverlay && animatedAvatarSrc ? (
          <img
            src={animatedAvatarSrc}
            alt=""
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute inset-0 z-[1] size-full object-cover transition-opacity duration-150',
              showAnimatedOverlay ? 'opacity-100' : 'opacity-0',
            )}
            loading="lazy"
            decoding="async"
          />
        ) : null}
        <AvatarFallback>{initials(name)}</AvatarFallback>
      </Avatar>
      {showDot ? (
        <AvatarBadge
          className={cn(
            'border-0 p-0 text-transparent ring-0',
            presenceBadge.offsetClass,
            presenceDotClass(user),
          )}
          style={{
            width: presenceBadge.sizePx,
            height: presenceBadge.sizePx,
            boxShadow: `0 0 0 ${presenceBadge.ringPx}px ${presenceRingColorVar(presenceRingClassName)}`,
          }}
          title={presenceDotTitle(user)}
        />
      ) : null}
      {notificationBadge ? (
        <AvatarNotificationBadge
          badge={notificationBadge}
          className={className}
          fallbackClassName={fallbackClassName}
          ringClassName={notificationRingClassName}
        />
      ) : null}
    </div>
  )
}
