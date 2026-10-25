import {
  useLinkProps,
  type LinkComponentProps,
  type RegisteredRouter,
  type UseLinkPropsOptions,
} from '@tanstack/react-router'
import { useTranslations } from '@syrnike13/ui/i18n'
import type { ReactNode } from 'react'

import {
  railIconItemRowClass,
  railIconSquircleProps,
} from '#/components/layout/shell-chrome'
import { Squircle } from '@syrnike13/ui/primitives/squircle'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@syrnike13/ui/primitives/tooltip'
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
  const t = useTranslations('layout.rail')
  return (
    <span
      data-slot="rail-indicator"
      data-unread=""
      aria-label={t('unread')}
      className={cn(railIndicatorBaseClass, 'h-2 opacity-100', className)}
    />
  )
}

type RailActiveIndicatorProps = {
  active: boolean
  /** Непрочитанные на неактивном пункте — полоска меньше активной (h-9). */
  unread?: boolean
}

/** Полоска активности слева у пункта рельса. */
export function RailActiveIndicator({
  active,
  unread = false,
}: RailActiveIndicatorProps) {
  const t = useTranslations('layout.rail')
  return (
    <span
      data-slot="rail-indicator"
      data-active={active ? '' : undefined}
      data-unread={!active && unread ? '' : undefined}
      aria-hidden={active || unread ? undefined : true}
      aria-label={!active && unread ? t('unread') : undefined}
      className={cn(
        railIndicatorBaseClass,
        active
          ? 'h-9 opacity-100 motion-height duration-150'
          : unread
            ? 'h-2 opacity-100 motion-height duration-150 group-hover:h-5.5'
            : 'h-2 opacity-0 motion-height transition-opacity duration-150 group-hover:h-5.5 group-hover:opacity-100',
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
    <TooltipProvider delay={0}>
      <Tooltip>
        <li className={railIconItemRowClass}>
          {/* key сбрасывает DOM: иначе idle opacity-0 + transition «съедает» unread */}
          <RailActiveIndicator
            key={indicatorKey}
            active={active}
            unread={unread}
          />
          <Squircle asChild {...railIconSquircleProps}>
            <TooltipTrigger
              render={
                <a
                  {...anchorProps}
                  className={cn(
                    'flex size-10 shrink-0 items-center justify-center overflow-hidden outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50',
                    active
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-card text-foreground hover:bg-primary hover:text-primary-foreground',
                  )}
                />
              }
            >
              {children}
            </TooltipTrigger>
          </Squircle>
        </li>
        <TooltipContent side="right" sideOffset={8}>
          {tooltipContent ?? title}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
