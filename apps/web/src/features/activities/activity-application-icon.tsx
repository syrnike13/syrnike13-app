import { ActivityIcon } from '#/components/icons'
import { cn } from '#/lib/utils'
import type { ActivityApplication } from './activity-api'
import { activityApplicationIconUrl } from './use-activities'

export function ActivityApplicationIcon({
  application,
  className,
}: {
  application: ActivityApplication | null
  className?: string
}) {
  const url = application ? activityApplicationIconUrl(application) : null
  if (url) {
    return (
      <img
        src={url}
        alt=""
        aria-hidden
        draggable={false}
        className={cn('shrink-0 rounded-md object-cover', className)}
      />
    )
  }
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary',
        className,
      )}
    >
      <ActivityIcon className="size-3/5" />
    </span>
  )
}
