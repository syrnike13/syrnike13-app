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
  resolveAvatarBadgeLayout,
  resolveAvatarSizePx,
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

/** Text shown in an unread badge: the count, capped, or `!` for a bare mention. */
export function notificationBadgeText(badge: NotificationBadgeState, max = 99) {
  return badge.count > max ? `${max}+` : String(badge.count || '!')
}

export function hasNotificationBadge(badge: NotificationBadgeState | undefined) {
  return Boolean(badge?.hasUnread || badge?.urgent)
}

/**
 * Unread count in the avatar's corner. Place it next to an `Avatar` with
 * `badgeCutout` inside a wrapper that sets the `--avatar-badge-*` variables.
 */
export function AvatarNotificationBadge({
  badge,
  max = 99,
}: {
  badge: NotificationBadgeState
  max?: number
}) {
  const t = useTranslations('notifications')
  if (!hasNotificationBadge(badge)) return null

  const countLabel =
    badge.count > 0 ? t('count', { count: badge.count }) : t('hasUnread')

  return (
    <AvatarBadge
      count={notificationBadgeText(badge, max)}
      aria-label={countLabel}
      title={countLabel}
    />
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
  onImageLoadingChange,
}: UserAvatarProps) {
  const t = useTranslations('chat')
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const [hovered, setHovered] = useState(false)
  const [hoverAnimationRequested, setHoverAnimationRequested] = useState(false)
  const name = user?.display_name ?? user?.username ?? '?'
  const showCount = hasNotificationBadge(notificationBadge)
  const showDot = Boolean(
    showPresence && user && user.relationship !== 'Blocked' && !showCount,
  )
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
  const avatarPx = resolveAvatarSizePx(className, fallbackClassName)
  const badgeLayout = showCount
    ? resolveAvatarBadgeLayout(avatarPx, {
        kind: 'count',
        label: notificationBadgeText(notificationBadge!),
      })
    : showDot
      ? resolveAvatarBadgeLayout(avatarPx, { kind: 'presence' })
      : null
  const presence = getUserPresence(user)
  const presenceKind =
    !user || !user.online || presence === 'Invisible'
      ? 'offline'
      : presence === 'Idle' || presence === 'SystemIdle'
        ? 'idle'
        : presence === 'Focus'
          ? 'focus'
          : presence === 'Busy'
            ? 'dnd'
            : 'online'

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
        showCount && 'overflow-visible',
      )}
      style={
        {
          '--avatar-badge-size': `${badgeLayout?.sizePx ?? 0}px`,
          '--avatar-badge-width': `${badgeLayout?.widthPx ?? 0}px`,
          '--avatar-badge-gap': `${badgeLayout?.gapPx ?? 0}px`,
          '--avatar-badge-font': badgeLayout?.fontPx
            ? `${badgeLayout.fontPx}px`
            : 'inherit',
        } as CSSVars
      }
      onPointerEnter={hoverFollowsSelf ? startHoverAnimation : undefined}
      onPointerLeave={hoverFollowsSelf ? () => setHovered(false) : undefined}
      onFocus={hoverFollowsSelf ? startHoverAnimation : undefined}
      onBlur={hoverFollowsSelf ? () => setHovered(false) : undefined}
    >
      <Avatar
        badgeCutout={badgeLayout != null}
        // eslint-disable-next-line shadcn/require-static-classes -- caller-owned avatar sizing
        className={cn(className, fallbackClassName)}
      >
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
        <AvatarBadge
          presence={presenceKind}
          title={presenceDotTitle(user, t)}
        />
      ) : null}
      {showCount && notificationBadge ? (
        <AvatarNotificationBadge badge={notificationBadge} />
      ) : null}
    </div>
  )
}
