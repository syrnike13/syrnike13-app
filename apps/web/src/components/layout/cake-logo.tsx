import { useEffect, useId, useState, type CSSProperties } from 'react'

import { cn } from '#/lib/utils'
import { useMediaQuery } from '#/hooks/use-media-query'

import { CAKE_TETROMINOES } from './cake-logo-data'
import { HalloweenDecor } from './cake-logo-halloween'
import cakeLogoArtwork from './cake-logo-artwork.png'

type CakeAnimationStyle = CSSProperties & {
  [property: `--cake-${string}`]: string | number
}

const CELL_SIZE = 2
const FALL_DURATION_MS = 280
const PIECE_INTERVAL_MS = 24
const STATIC_HOLD_MS = 1500
const TIMELINE_STEP_MS = 20

const PIECES = CAKE_TETROMINOES.map((piece, index) => ({
  ...piece,
  delay: index * PIECE_INTERVAL_MS,
}))

const ASSEMBLY_MS = (PIECES.length - 1) * PIECE_INTERVAL_MS + FALL_DURATION_MS
const CYCLE_MS = STATIC_HOLD_MS + ASSEMBLY_MS

export const CAKE_LOGO_VARIANTS = ['classic', 'witch'] as const

export type CakeLogoVariant = (typeof CAKE_LOGO_VARIANTS)[number]

type CakeLogoPhase = 'still' | 'assembly'

/** Seasonal scene that plays automatically while the Halloween window is open. */
export const HALLOWEEN_CAKE_VARIANT: CakeLogoVariant = 'witch'

/** Fast tetromino assembly with one seamless artwork layer beneath the blocks. */
export function CakeLogo({
  className,
  previewMotion = false,
  variant = 'classic',
}: {
  className?: string
  /** Explicit dev-preview playback, including when reduced motion is enabled. */
  previewMotion?: boolean
  /** `witch` keeps the logo whole and only adds Halloween set dressing. */
  variant?: CakeLogoVariant
}) {
  const maskId = useId()
  const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const animate = previewMotion || !prefersReducedMotion
  const [timeline, setTimeline] = useState({ cycle: 0, elapsed: 0 })

  useEffect(() => {
    if (!animate) return
    const startedAt = Date.now()

    // One clock handles landing and replay. Completed blocks leave the DOM,
    // while CSS only interpolates their fall.
    function updateTimeline() {
      const elapsed = Date.now() - startedAt
      setTimeline({
        cycle: Math.floor(elapsed / CYCLE_MS),
        elapsed: elapsed % CYCLE_MS,
      })
    }

    updateTimeline()
    const timer = window.setInterval(updateTimeline, TIMELINE_STEP_MS)
    return () => window.clearInterval(timer)
  }, [animate])

  const assemblyElapsed = timeline.elapsed - STATIC_HOLD_MS
  const assembling =
    animate && variant === 'classic' && assemblyElapsed >= 0
  const phase: CakeLogoPhase = assembling ? 'assembly' : 'still'

  const cycleStyle: CakeAnimationStyle = {
    '--cake-cycle-duration': `${CYCLE_MS}ms`,
    '--cake-fall-duration': `${FALL_DURATION_MS}ms`,
  }

  return (
    <svg
      key={`${timeline.cycle}:${phase}`}
      viewBox="-12 -4 44 34"
      data-phase={phase}
      data-variant={variant}
      data-motion-preview={previewMotion ? '' : undefined}
      className={cn('cake-logo size-full', className)}
      style={cycleStyle}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      {assembling ? (
        <defs>
          <mask
            id={maskId}
            className="cake-logo-mask"
            maskUnits="userSpaceOnUse"
            x={0}
            y={0}
            width={20}
            height={26}
          >
            {PIECES.map((piece, index) =>
              assembling &&
              assemblyElapsed >= piece.delay + FALL_DURATION_MS ? (
                <g key={index} data-landed-piece="">
                  {piece.cells.map(([x, y]) => (
                    <rect
                      key={`${x}:${y}`}
                      x={x}
                      y={y}
                      width={CELL_SIZE}
                      height={CELL_SIZE}
                    />
                  ))}
                </g>
              ) : null,
            )}
          </mask>
        </defs>
      ) : null}
      <image
        href={cakeLogoArtwork}
        x={0}
        y={0}
        width={20}
        height={26}
        mask={assembling ? `url(#${maskId})` : undefined}
        className="cake-logo-artwork"
      />
      {assembling
        ? PIECES.map((piece, index) => {
            if (assemblyElapsed >= piece.delay + FALL_DURATION_MS) return null
            const pieceStyle: CakeAnimationStyle = {
              '--cake-piece-delay': `${piece.delay}ms`,
            }
            return (
              <g
                key={index}
                className="cake-logo-piece"
                data-shape={piece.kind}
                style={pieceStyle}
              >
                <g className="cake-tetromino-blocks">
                  {piece.cells.map(([x, y]) => (
                    <rect
                      key={`${x}:${y}`}
                      x={x}
                      y={y}
                      width={CELL_SIZE}
                      height={CELL_SIZE}
                    />
                  ))}
                </g>
              </g>
            )
          })
        : null}
      {variant === 'witch' ? <HalloweenDecor /> : null}
    </svg>
  )
}
