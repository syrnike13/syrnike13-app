import type { Badge } from '@syrnike13/api-types'

import { badgeIconUrl } from '#/lib/media'
import { cn } from '#/lib/utils'

const sizeMap = {
  sm: { box: 'size-8 text-[9px]', img: 'size-4' },
  md: { box: 'size-10 text-[10px]', img: 'size-6' },
  lg: { box: 'size-12 text-[10px]', img: 'size-7' },
  xl: { box: 'size-16 text-xs', img: 'size-10' },
} as const

export function BadgeIcon({
  badge,
  previewUrl,
  size = 'md',
  className,
}: {
  badge: Pick<Badge, 'icon'>
  previewUrl?: string | null
  size?: keyof typeof sizeMap
  className?: string
}) {
  const iconUrl = previewUrl ?? badgeIconUrl(badge.icon)
  const sizes = sizeMap[size]

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/50 text-muted-foreground',
        sizes.box,
        className,
      )}
    >
      {iconUrl ? (
        <img
          src={iconUrl}
          alt=""
          className={cn(sizes.img, 'object-contain')}
        />
      ) : (
        '—'
      )}
    </span>
  )
}
