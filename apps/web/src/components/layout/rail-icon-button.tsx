import { Link } from '@tanstack/react-router'
import type { ComponentProps, ReactNode } from 'react'

import {
  railIconButtonClass,
  railIconIdleClass,
  railIconItemRowClass,
} from '#/components/layout/shell-chrome'
import { Button } from '#/components/ui/button'
import { cn } from '#/lib/utils'

/**
 * База полоски. Opacity не анимируем: transition opacity + group-hover
 * даёт вспышку «появилась и сразу пропала» при смене idle → unread.
 * Высоту между видимыми состояниями анимируем отдельно.
 */
const railIndicatorBaseClass =
  'pointer-events-none absolute top-1/2 -left-1 z-10 w-1 -translate-y-1/2 rounded-r-full bg-foreground'

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

type RailIconButtonProps = {
  active: boolean
  unread?: boolean
  title: string
  children: ReactNode
} & ComponentProps<typeof Link>

/** Квадратная кнопка рельса (Home, сервер): единая вёрстка и индикатор активности. */
export function RailIconButton({
  active,
  unread = false,
  title,
  children,
  className,
  ...linkProps
}: RailIconButtonProps) {
  const indicatorKey = active ? 'active' : unread ? 'unread' : 'idle'

  return (
    <div className={railIconItemRowClass}>
      {/* key сбрасывает DOM: иначе idle opacity-0 + transition «съедает» unread */}
      <RailActiveIndicator
        key={indicatorKey}
        active={active}
        unread={unread}
      />
      <Button
        size="icon"
        variant={active ? 'default' : 'ghost'}
        className={cn(railIconButtonClass, !active && railIconIdleClass)}
        title={title}
        asChild
      >
        <Link className={className} {...linkProps}>
          {children}
        </Link>
      </Button>
    </div>
  )
}
