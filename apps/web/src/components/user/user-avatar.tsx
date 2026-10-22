import type { User } from '@syrnike13/api-types'
import { useEffect, useState } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'

import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
} from '@syrnike13/ui/primitives/avatar'
import type { NotificationBadgeState } from '#/features/notifications/notification-selectors'
import { RetryingAvatarImage } from '#/components/user/retrying-avatar-image'
import {
  presenceRingColorVar,
  resolvePresenceBadgeLayoutForAvatar,
} from '#/components/user/user-avatar-presence'
import { useImageRetry } from '#/hooks/use-image-retry'
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
  /**
   * Где ловить наведение для `animated="hover"`. `self` (по умолчанию) — сам
   * аватар. `parent` — ближайший родитель с `data-avatar-hover-scope`: так
   * анимируются аватары в строках списков, где hover подсвечивает всю строку.
   */
  hoverScope?: 'self' | 'parent'
  speaking?: boolean
  /** Кольцо вокруг точки статуса (фон под аватаром) */
  presenceRingClassName?: string
  /** Кольцо вокруг бейджа уведомлений */
  notificationRingClassName?: string
  /** Сообщает о загрузке основного изображения аватара. */
  onImageLoadingChange?: (
    status: 'idle' | 'loading' | 'loaded' | 'error',
  ) => void
}

export function UserAvatar({
  user,
  className,
  fallbackClassName,
  imageSrc,
  showPresence = true,
  notificationBadge,
  animated = 'hover',
  hoverScope = 'self',
  speaking = false,
  presenceRingClassName = 'border-card',
  notificationRingClassName = 'border-card',
  onImageLoadingChange,
}: UserAvatarProps) {
  const t = useTranslations('chat')
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const [hovered, setHovered] = useState(false)
  const [hoverAnimationRequested, setHoverAnimationRequested] = useState(false)
  const name = user?.display_name ?? user?.username ?? '?'
  const hasNotificationBadge = Boolean(
    notificationBadge?.hasUnread || notificationBadge?.urgent,
  )
  const showDot =
    showPresence && user && user.relationship !== 'Blocked' && !hasNotificationBadge
  const useImageSrcOverride = imageSrc != null
  const hoverFollowsSelf =
    animated === 'hover' && hoverScope === 'self' && !useImageSrcOverride
  const hoverFollowsScope =
    animated === 'hover' && hoverScope === 'parent' && !useImageSrcOverride

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
  const animatedRetry = useImageRetry(animatedAvatarSrc)
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

  useEffect(() => {
    if (!hoverFollowsScope || !container) return

    const scope = container.closest('[data-avatar-hover-scope]')
    if (!scope) return

    const start = () => startHoverAnimation()
    const stop = () => setHovered(false)

    scope.addEventListener('pointerenter', start)
    scope.addEventListener('pointerleave', stop)
    scope.addEventListener('focusin', start)
    scope.addEventListener('focusout', stop)

    return () => {
      scope.removeEventListener('pointerenter', start)
      scope.removeEventListener('pointerleave', stop)
      scope.removeEventListener('focusin', start)
      scope.removeEventListener('focusout', stop)
      setHovered(false)
    }
  }, [container, hoverFollowsScope])

  return (
    <div
      ref={setContainer}
      className={cn(
        'relative shrink-0',
        hasNotificationBadge && 'overflow-visible',
      )}
      onPointerEnter={hoverFollowsSelf ? startHoverAnimation : undefined}
      onPointerLeave={hoverFollowsSelf ? () => setHovered(false) : undefined}
      onFocus={hoverFollowsSelf ? startHoverAnimation : undefined}
      onBlur={hoverFollowsSelf ? () => setHovered(false) : undefined}
    >
      {/* eslint-disable-next-line shadcn/require-static-classes -- caller-owned avatar sizing */}
      <Avatar className={cn(className, fallbackClassName)}>
        {avatarSrc ? (
          <RetryingAvatarImage
            src={avatarSrc}
            alt={name}
            onLoadingStatusChange={onImageLoadingChange}
            className={cn(
              mountAnimatedOverlay && 'transition-opacity duration-150',
              showAnimatedOverlay && 'opacity-0',
            )}
          />
        ) : null}
        {/* Форму задаёт сам оверлей: `Avatar` не клипует содержимое, поэтому без
            `rounded-full` GIF на hover/speaking выходил квадратом. */}
        {mountAnimatedOverlay && animatedAvatarSrc && !animatedRetry.failed ? (
          <img
            key={animatedRetry.attempt}
            onError={animatedRetry.onError}
            src={animatedAvatarSrc}
            alt=""
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute inset-0 size-full rounded-full object-cover transition-opacity duration-150',
              showAnimatedOverlay ? 'opacity-100' : 'opacity-0',
            )}
            loading="lazy"
            decoding="async"
          />
        ) : null}
        <AvatarFallback>{initials(name)}</AvatarFallback>
      </Avatar>
      {showDot ? (
        // design-allow restyle-shared: app-level presence dot wrapper
        <AvatarBadge
          className={cn(
            'presence-dot size-(--dot-size) ring-0',
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
          title={presenceDotTitle(user, t)}
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
