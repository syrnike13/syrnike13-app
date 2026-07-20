import {
  useLinkProps,
  type LinkComponentProps,
  type RegisteredRouter,
  type UseLinkPropsOptions,
} from '@tanstack/react-router'
import type { ReactNode } from 'react'

import {
  railIconButtonClass,
  railIconIdleClass,
  railIconItemRowClass,
  railIconSquircleProps,
} from '#/components/layout/shell-chrome'
import { Button } from '#/components/ui/button'
import { Squircle } from '#/components/ui/squircle'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { cn } from '#/lib/utils'

/**
 * База полоски. Opacity не анимируем: transition opacity + group-hover
 * даёт вспышку «появилась и сразу пропала» при смене idle → unread.
 * Высоту между видимыми состояниями анимируем отдельно.
 */
const railIndicatorBaseClass =
  'pointer-events-none absolute top-1/2 -left-1 z-10 w-1 -translate-y-1/2 rounded-r-full bg-foreground'

/** Статичная полоска непрочитанного без hover/active-поведения. */
export function RailUnreadIndicator({ className }: { className?: string }) {
  return (
    <span
      data-slot="rail-indicator"
      data-unread=""
      aria-label="Есть непрочитанные сообщения"
      className={cn(railIndicatorBaseClass, 'h-2 opacity-100', className)}
    />
  )
}

type RailActiveIndicatorProps = {
  active: boolean
  /** Непрочитанные на неактивном пункте — полоска меньше активной (h-8). */
  unread?: boolean
}

/** Discord-style полоска слева у пункта рельса. */
export function RailActiveIndicator({
  active,
  unread = false,
}: RailActiveIndicatorProps) {
  return (
    <span
      data-slot="rail-indicator"
      data-active={active ? '' : undefined}
      data-unread={!active && unread ? '' : undefined}
      aria-hidden={active || unread ? undefined : true}
      aria-label={
        !active && unread ? 'Есть непрочитанные сообщения' : undefined
      }
      className={cn(
        railIndicatorBaseClass,
        active
          ? 'h-8 opacity-100 transition-[height] duration-150'
          : unread
            ? 'h-2 opacity-100 transition-[height] duration-150 group-hover:h-5'
            : 'h-2 opacity-0 transition-[height,opacity] duration-150 group-hover:h-5 group-hover:opacity-100',
      )}
    />
  )
}

type RailIconButtonProps<TTo extends string> = {
  active: boolean
  unread?: boolean
  title: string
  tooltipContent?: ReactNode
  children: ReactNode
} & LinkComponentProps<'a', RegisteredRouter, string, TTo, string, ''>

/** Квадратная кнопка рельса (Home, сервер): единая вёрстка и индикатор активности. */
export function RailIconButton<TTo extends string>(
  props: RailIconButtonProps<TTo>,
) {
  const {
    active,
    unread = false,
    title,
    tooltipContent,
    children,
    ...linkProps
  } = props
  const indicatorKey = active ? 'active' : unread ? 'unread' : 'idle'
  const anchorProps = useLinkProps<RegisteredRouter, string, TTo>({
    ...linkProps,
    'aria-label': title,
  } as UseLinkPropsOptions<RegisteredRouter, string, TTo, string, ''>)

  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <div className={railIconItemRowClass}>
          {/* key сбрасывает DOM: иначе idle opacity-0 + transition «съедает» unread */}
          <RailActiveIndicator
            key={indicatorKey}
            active={active}
            unread={unread}
          />
          <Squircle asChild {...railIconSquircleProps}>
            <Button
              size="icon"
              variant={active ? 'default' : 'ghost'}
              className={cn(railIconButtonClass, !active && railIconIdleClass)}
              asChild
            >
              <TooltipTrigger asChild>
                <a {...anchorProps}>{children}</a>
              </TooltipTrigger>
            </Button>
          </Squircle>
        </div>
        <TooltipContent side="right" sideOffset={8} className="font-black">
          {tooltipContent ?? title}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
