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
  if (!badge.hasUnread && !badge.urgent) return null

  const countLabel =
    badge.count > 0 ? `${badge.count} уведомлений` : 'Есть уведомления'

  if (mode === 'dot') {
    return (
      <Badge
        variant="destructive"
        aria-label={countLabel}
        className={cn(
          'pointer-events-none size-2 min-w-0 shrink-0 rounded-full border-background p-0',
          className,
        )}
      />
    )
  }

  const display = badge.count > max ? `${max}+` : String(badge.count)

  return (
    <Badge
      variant="destructive"
      aria-label={countLabel}
      className={cn(
        'pointer-events-none h-4 min-w-4 border-background px-1 text-[10px] leading-none shadow-sm',
        className,
      )}
    >
      {display}
    </Badge>
  )
}
