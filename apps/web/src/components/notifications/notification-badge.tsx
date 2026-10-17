import { useTranslations } from '@syrnike13/ui/i18n'
import { Badge } from '#/components/ui/badge'
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
        variant="contrast"
        aria-label={countLabel}
        className={cn(
          'pointer-events-none size-2 min-w-0 shrink-0 p-0',
          className,
        )}
      />
    )
  }

  const display = badge.count > max ? `${max}+` : String(badge.count)

  return (
    <Badge
      variant="contrast"
      aria-label={countLabel}
      className={cn(
        'pointer-events-none h-4 min-w-4 px-1 text-[0.625rem] leading-none',
        className,
      )}
    >
      {display}
    </Badge>
  )
}
