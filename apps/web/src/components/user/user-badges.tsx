import type { User } from '@syrnike13/api-types'

import { FxImage } from '#/components/ui/fx-image'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { badgeIconUrl } from '#/lib/media'
import { cn } from '#/lib/utils'

type UserBadgesProps = {
  badges?: User['badges']
  className?: string
  size?: 'sm' | 'md'
}

export function UserBadges({
  badges,
  className,
  size = 'md',
}: UserBadgesProps) {
  const visibleBadges = (badges ?? []).filter((badge) => badgeIconUrl(badge.icon))
  if (visibleBadges.length === 0) return null

  return (
    <TooltipProvider>
      <div className={cn('flex min-w-0 flex-wrap items-center gap-1.5', className)}>
        {visibleBadges.map((badge) => {
          const iconUrl = badgeIconUrl(badge.icon)
          if (!iconUrl) return null

          return (
            <Tooltip key={badge._id}>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    'inline-flex shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/50',
                    size === 'sm' ? 'size-6' : 'size-7',
                  )}
                  aria-label={badge.name}
                  title={badge.name}
                  tabIndex={0}
                >
                  <FxImage
                    src={iconUrl}
                    wrapperClassName={cn(size === 'sm' ? 'size-4' : 'size-5')}
                    className="size-full object-contain"
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                <div className="max-w-56">
                  <p className="font-medium">{badge.name}</p>
                  {badge.description ? (
                    <p className="mt-1 text-muted-foreground">{badge.description}</p>
                  ) : null}
                </div>
              </TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </TooltipProvider>
  )
}
