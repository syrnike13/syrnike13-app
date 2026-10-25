import type { ComponentPropsWithoutRef, ReactNode } from 'react'

import {
  floatingBarRingProps,
  floatingBarSquircleProps,
} from '#/components/layout/shell-chrome'
import {
  Squircle,
  type SquircleRingOptions,
} from '@syrnike13/ui/primitives/squircle'
import { cn } from '#/lib/utils'

type FloatingBarShellProps = {
  children: ReactNode
  /** Классы обёртки (pointer-events, opacity, drag-ring…). */
  className?: string
  /** Классы поверхности Squircle (flex, bg override…). */
  surfaceClassName?: string
  /**
   * Обводка. По умолчанию `floatingBarRingProps` (shell-divider, 1px).
   * `false` — выключить; объект — переопределить width/цвет.
   */
  ring?: boolean | SquircleRingOptions
} & Omit<ComponentPropsWithoutRef<'div'>, 'children' | 'className'>

/**
 * Плавающая «таблетка» (UserPanel, композер): fluid Squircle.
 * Обводка — через prop `ring` примитива (двойной слой), не CSS border/ring.
 */
export function FloatingBarShell({
  children,
  className,
  surfaceClassName,
  ring = floatingBarRingProps,
  ...surfaceProps
}: FloatingBarShellProps) {
  return (
    <div className={className}>
      <Squircle
        {...floatingBarSquircleProps}
        ring={ring}
        className={cn(
          'gradient-surface-floating w-full overflow-hidden bg-secondary text-secondary-foreground',
          // eslint-disable-next-line shadcn/require-static-classes -- caller-owned surface styling
          surfaceClassName,
        )}
        {...surfaceProps}
      >
        {children}
      </Squircle>
    </div>
  )
}
