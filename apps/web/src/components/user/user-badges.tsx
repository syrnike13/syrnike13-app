import type { User } from '@syrnike13/api-types'

import { FxImage } from '#/components/ui/fx-image'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { badgeIconSizeClass, type BadgeIconSize } from '#/lib/badge-icon'
import { badgeIconUrl } from '#/lib/media'
import { cn } from '#/lib/utils'

type UserBadgesProps = {
  badges?: User['badges']
  className?: string
  size?: BadgeIconSize
}

function BadgeIconImage({
  src,
  size,
}: {
  src: string
  size: BadgeIconSize | 'tooltip'
}) {
  return (
    <FxImage
      src={src}
      wrapperClassName={cn(badgeIconSizeClass[size], 'shrink-0')}
      className="size-full object-contain"
    />
  )
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
      <div className={cn('flex min-w-0 flex-wrap items-center gap-1', className)}>
        {visibleBadges.map((badge) => {
          const iconUrl = badgeIconUrl(badge.icon)
          if (!iconUrl) return null

          return (
            <Tooltip key={badge._id}>
              <TooltipTrigger asChild>
                <span
                  className="inline-flex shrink-0 items-center justify-center"
                  aria-label={badge.name}
                  tabIndex={0}
                >
                  <BadgeIconImage src={iconUrl} size={size} />
                </span>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                sideOffset={8}
                className="px-2.5 py-2 text-left text-wrap"
              >
                <div className="flex max-w-64 items-center gap-2.5">
                  <BadgeIconImage src={iconUrl} size="tooltip" />
                  <div className="min-w-0">
                    <p className="text-sm leading-tight font-semibold text-popover-foreground">
                      {badge.name}
                    </p>
                    {badge.description ? (
                      <p className="mt-1 text-xs leading-snug text-muted-foreground">
                        {badge.description}
                      </p>
                    ) : null}
                  </div>
                </div>
              </TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </TooltipProvider>
  )
}
