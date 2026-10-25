import { useTranslations } from '@syrnike13/ui/i18n'
import { Badge } from '@syrnike13/ui/primitives/badge'
import type { NotificationBadgeState } from '#/features/notifications/notification-selectors'
import { cn } from '#/lib/utils'

type NotificationBadgeMode = 'count' | 'dot'

type NotificationBadgeProps = {
  badge: NotificationBadgeState
  className?: string
  max?: number
  mode?: NotificationBadgeMode
}

export function NotificationBadge({
  badge,
  className,
  max = 99,
  mode = 'count',
}: NotificationBadgeProps) {
  const t = useTranslations('notifications')
  if (!badge.hasUnread && !badge.urgent) return null

  const countLabel =
    badge.count > 0
      ? t('count', { count: badge.count })
      : t('hasUnread')

  if (mode === 'dot') {
    return (
      <Badge
        variant="destructive"
        size="dot"
        aria-label={countLabel}
        className={cn('pointer-events-none shrink-0', className)}
      />
    )
  }

  const display = badge.count > max ? `${max}+` : String(badge.count)

  return (
    <Badge
      variant="destructive"
      size="count"
      aria-label={countLabel}
      className={cn('pointer-events-none', className)}
    >
      {display}
    </Badge>
  )
}
