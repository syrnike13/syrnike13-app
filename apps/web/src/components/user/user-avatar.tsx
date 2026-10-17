import type { User } from '@syrnike13/api-types'
import { useState } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'

import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarImage,
} from '@syrnike13/ui/primitives/avatar'
import type { NotificationBadgeState } from '#/features/notifications/notification-selectors'
import {
  presenceRingColorVar,
  resolvePresenceBadgeLayoutForAvatar,
} from '#/components/user/user-avatar-presence'
import { userAvatarUrl } from '#/lib/media'
import { getUserPresence, presenceDotTitle } from '#/lib/presence'
import type { CSSVars } from '#/lib/css-vars'
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
  const t = useTranslations('notifications')
  if (!badge.hasUnread && !badge.urgent) return null

  const layout = resolvePresenceBadgeLayoutForAvatar(className, fallbackClassName)
  const countLabel =
    badge.count > 0 ? t('count', { count: badge.count }) : t('hasUnread')
  const display = badge.count > max ? `${max}+` : String(badge.count || '!')

  return (
    <span
      aria-label={countLabel}
      title={countLabel}
      data-slot="avatar-badge"
      className={cn(
        'avatar-badge absolute right-0.5 bottom-0.5 z-10 grid place-items-center rounded-full leading-none select-none',
        'border-0 bg-destructive-contrast font-bold text-destructive-foreground tabular-nums',
        layout.offsetClass,
        badge.count > 9
          ? 'h-(--badge-w) min-w-(--badge-w) px-0.5'
          : 'aspect-square size-(--badge-w)',
      )}
      style={
        {
          '--badge-w': `${layout.sizePx}px`,
          '--badge-font': `${Math.round(layout.sizePx * 0.62)}px`,
          '--badge-ring': `${layout.ringPx}px`,
          '--badge-ring-color': presenceRingColorVar(ringClassName),
        } as CSSVars
      }
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
  const presence = getUserPresence(user)
  const dotClass =
    !user || !user.online || presence === 'Invisible'
      ? 'bg-muted-foreground'
      : presence === 'Idle' || presence === 'SystemIdle'
        ? 'bg-chart-2'
        : presence === 'Focus'
          ? 'bg-chart-5'
          : presence === 'Busy'
            ? 'bg-destructive'
            : 'bg-chart-3'

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
      {/* eslint-disable-next-line shadcn/require-static-classes -- caller-owned avatar sizing */}
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
              'pointer-events-none absolute inset-0 z-1 size-full object-cover transition-opacity duration-150',
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
            'presence-dot size-(--dot-size) border-0 p-0 text-transparent ring-0',
            // eslint-disable-next-line shadcn/require-static-classes -- static offset class from layout helper
            presenceBadge.offsetClass,
            dotClass,
          )}
          style={
            {
              '--dot-size': `${presenceBadge.sizePx}px`,
              '--dot-ring': `${presenceBadge.ringPx}px`,
              '--dot-ring-color': presenceRingColorVar(presenceRingClassName),
            } as CSSVars
          }
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
