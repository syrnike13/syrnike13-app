import {
  StaticSquircle,
  SquircleNoScript,
} from '@squircle-js/react'
import {
  useEffect,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactNode,
} from 'react'

import { cn } from '#/lib/utils'

/**
 * Единый iOS-like smoothing для дизайн-системы.
 * Потребители не должны хардкодить 0.6 из библиотеки.
 */
export const DEFAULT_SQUIRCLE_CORNER_SMOOTHING = 1

/** Толщина обводки по умолчанию (как бывший `ring-1`). */
export const DEFAULT_SQUIRCLE_RING_WIDTH_PX = 1

/**
 * Цвет обводки — фон внешнего слоя (не CSS `border-color`).
 * `clip-path` не умеет нормальный border/box-shadow ring.
 */
export const DEFAULT_SQUIRCLE_RING_CLASS = 'bg-shell-divider' as const

type SquircleDomProps = Omit<
  ComponentPropsWithoutRef<'div'>,
  'children' | 'className' | 'style' | 'width' | 'height'
>

export type SquircleRingOptions = {
  /** Толщина обводки в px. */
  width?: number
  /**
   * Цвет обводки через background внешнего Squircle
   * (например `bg-shell-divider`, `bg-border`).
   */
  className?: string
}

export type SquircleProps = SquircleDomProps & {
  /** Радиус угла до smoothing (как cornerRadius в Figma). */
  cornerRadius: number
  /**
   * Сглаживание углов 0…1. По умолчанию полное (`DEFAULT_SQUIRCLE_CORNER_SMOOTHING`).
   */
  cornerSmoothing?: number
  /**
   * Смержить clip-path на ребёнка (Button, Link, …).
   * Только для фиксированного размера; при `ring` применяется к внутреннему слою.
   */
  asChild?: boolean
  /**
   * Обводка: внешний Squircle-слой с `bg-*` + padding.
   * CSS `border` / `ring-*` с clip-path не работают — используй это.
   *
   * `true` → дефолты дизайн-системы; объект → кастом; `false`/omit → без обводки.
   */
  ring?: boolean | SquircleRingOptions
  /**
   * Квадрат: задаёт и width, и height.
   * Предпочтительнее для иконок/аватаров фиксированного размера.
   */
  size?: number
  width?: number
  height?: number
  children?: ReactNode
  className?: string
  style?: CSSProperties
}

export type ResolvedSquircleRing = {
  width: number
  className: string
}

/** Нормализует `ring` prop в конкретные width/className. */
export function resolveSquircleRing(
  ring: boolean | SquircleRingOptions | undefined,
): ResolvedSquircleRing | null {
  if (!ring) return null
  if (ring === true) {
    return {
      width: DEFAULT_SQUIRCLE_RING_WIDTH_PX,
      className: DEFAULT_SQUIRCLE_RING_CLASS,
    }
  }
  return {
    width: ring.width ?? DEFAULT_SQUIRCLE_RING_WIDTH_PX,
    className: ring.className ?? DEFAULT_SQUIRCLE_RING_CLASS,
  }
}

type SquircleSurfaceProps = {
  cornerRadius: number
  cornerSmoothing: number
  asChild: boolean
  pathWidth: number
  pathHeight: number
  children?: ReactNode
  className?: string
  style?: CSSProperties
} & SquircleDomProps

function SquircleSurface({
  cornerRadius,
  cornerSmoothing,
  asChild,
  pathWidth,
  pathHeight,
  children,
  className,
  style,
  ...props
}: SquircleSurfaceProps) {
  const canClip = pathWidth > 0 && pathHeight > 0

  return (
    <StaticSquircle
      asChild={asChild}
      width={canClip ? pathWidth : 1}
      height={canClip ? pathHeight : 1}
      cornerRadius={cornerRadius}
      cornerSmoothing={cornerSmoothing}
      className={className}
      style={style}
      data-slot="squircle"
      data-squircle={cornerRadius}
      {...props}
    >
      {children}
    </StaticSquircle>
  )
}

type SquircleLayersProps = {
  cornerRadius: number
  cornerSmoothing: number
  asChild: boolean
  pathWidth: number
  pathHeight: number
  ring: ResolvedSquircleRing | null
  children?: ReactNode
  className?: string
  style?: CSSProperties
} & SquircleDomProps

/**
 * Один или два StaticSquircle: внешний = обводка, внутренний = контент.
 * Внешний radius = cornerRadius; внутренний = cornerRadius − ring.width.
 */
function SquircleLayers({
  cornerRadius,
  cornerSmoothing,
  asChild,
  pathWidth,
  pathHeight,
  ring,
  children,
  className,
  style,
  ...props
}: SquircleLayersProps) {
  if (!ring) {
    return (
      <SquircleSurface
        asChild={asChild}
        cornerRadius={cornerRadius}
        cornerSmoothing={cornerSmoothing}
        pathWidth={pathWidth}
        pathHeight={pathHeight}
        className={className}
        style={style}
        {...props}
      >
        {children}
      </SquircleSurface>
    )
  }

  const innerWidth = Math.max(0, pathWidth - ring.width * 2)
  const innerHeight = Math.max(0, pathHeight - ring.width * 2)
  const innerRadius = Math.max(0, cornerRadius - ring.width)

  return (
    <SquircleSurface
      asChild={false}
      cornerRadius={cornerRadius}
      cornerSmoothing={cornerSmoothing}
      pathWidth={pathWidth}
      pathHeight={pathHeight}
      className={ring.className}
      style={{ padding: ring.width }}
      data-squircle-ring=""
    >
      <SquircleSurface
        asChild={asChild}
        cornerRadius={innerRadius}
        cornerSmoothing={cornerSmoothing}
        pathWidth={innerWidth}
        pathHeight={innerHeight}
        className={cn('size-full min-h-0 min-w-0', className)}
        style={style}
        {...props}
      >
        {children}
      </SquircleSurface>
    </SquircleSurface>
  )
}

/**
 * Squircle дизайн-системы поверх `@squircle-js/react`.
 *
 * - Фиксированный размер → сразу известный path (+ опционально `asChild`)
 * - Fluid → measure-host + path по ResizeObserver
 * - `ring` → двойной слой (внешний bg = цвет обводки), т.к. clip-path
 *   срезает CSS border / box-shadow ring
 *
 * @example
 * ```tsx
 * <Squircle asChild size={40} cornerRadius={14}>
 *   <Button size="icon">…</Button>
 * </Squircle>
 *
 * <Squircle cornerRadius={10} ring className="w-full bg-secondary">
 *   fluid bar with outline
 * </Squircle>
 * ```
 */
export function Squircle({
  cornerRadius,
  cornerSmoothing = DEFAULT_SQUIRCLE_CORNER_SMOOTHING,
  asChild = false,
  ring: ringProp,
  size,
  width,
  height,
  children,
  className,
  style,
  ...props
}: SquircleProps) {
  const ring = resolveSquircleRing(ringProp)
  const fixedWidth = width ?? size
  const fixedHeight = height ?? size
  const hasFixedSize =
    fixedWidth != null &&
    fixedHeight != null &&
    fixedWidth > 0 &&
    fixedHeight > 0

  const [measured, setMeasured] = useState({ width: 0, height: 0 })
  const [measureNode, setMeasureNode] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    if (hasFixedSize || !measureNode) return

    const update = () => {
      setMeasured({
        width: measureNode.offsetWidth,
        height: measureNode.offsetHeight,
      })
    }
    update()

    const observer = new ResizeObserver(update)
    observer.observe(measureNode)
    return () => observer.disconnect()
  }, [hasFixedSize, measureNode])

  if (hasFixedSize) {
    return (
      <SquircleLayers
        asChild={asChild}
        cornerRadius={cornerRadius}
        cornerSmoothing={cornerSmoothing}
        pathWidth={fixedWidth}
        pathHeight={fixedHeight}
        ring={ring}
        className={className}
        style={style}
        {...props}
      >
        {children}
      </SquircleLayers>
    )
  }

  return (
    <div ref={setMeasureNode} className="w-full min-w-0">
      <SquircleLayers
        asChild={false}
        cornerRadius={cornerRadius}
        cornerSmoothing={cornerSmoothing}
        pathWidth={measured.width}
        pathHeight={measured.height}
        ring={ring}
        className={className}
        style={style}
        {...props}
      >
        {children}
      </SquircleLayers>
    </div>
  )
}

export { SquircleNoScript }
