import { CAKE_PIXELS } from '#/components/layout/cake-logo-data'

/**
 * Syrnik mascot scenes for empty states, drawn from the same 20 × 26 pixel
 * sprite as the logo. A scene swaps the eyes and adds a pixel overlay; new
 * scenes are a new entry in SCENES.
 */
export type SyrnikSceneName = 'sleeping'

type Pixel = readonly [x: number, y: number]

const SPRITE_WIDTH = 20
const SPRITE_HEIGHT = 26
/** Extra room above and to the right of the sprite for overlays. */
const PAD_TOP = 8
const PAD_RIGHT = 8

const FACE_FILL = '#fff3b6'
const INK_FILL = '#000000'

const HAPPY_EYES: readonly Pixel[] = [
  [6, 16], [7, 16], [8, 16], [13, 16], [14, 16], [15, 16],
  [5, 17], [9, 17], [12, 17], [16, 17],
]

const SLEEPING_EYES: readonly Pixel[] = [
  [6, 17], [7, 17], [8, 17], [13, 17], [14, 17], [15, 17],
]

/** 3 × 3 "Z" glyph, top-left origin. */
const Z_GLYPH: readonly Pixel[] = [
  [0, 0], [1, 0], [2, 0], [1, 1], [0, 2], [1, 2], [2, 2],
]

type Overlay = {
  pixels: readonly Pixel[]
  /** Offset in sprite pixels; overlays may sit in the padding (negative y). */
  at: Pixel
  className?: string
}

type Scene = {
  eyes: readonly Pixel[]
  overlays: readonly Overlay[]
}

const SCENES: Record<SyrnikSceneName, Scene> = {
  sleeping: {
    eyes: SLEEPING_EYES,
    overlays: [
      { pixels: Z_GLYPH, at: [17, 2], className: 'syrnik-z syrnik-z-1' },
      { pixels: Z_GLYPH, at: [21, -2], className: 'syrnik-z syrnik-z-2' },
      { pixels: Z_GLYPH, at: [24, -6], className: 'syrnik-z syrnik-z-3' },
    ],
  },
}

const happyEyeKeys = new Set(HAPPY_EYES.map(([x, y]) => `${x}:${y}`))

export function SyrnikScene({ scene }: { scene: SyrnikSceneName }) {
  const { eyes, overlays } = SCENES[scene]

  return (
    <svg
      viewBox={`0 ${-PAD_TOP} ${SPRITE_WIDTH + PAD_RIGHT} ${SPRITE_HEIGHT + PAD_TOP}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      className="syrnik-scene"
    >
      {CAKE_PIXELS.map(({ x, y, fill }) => (
        <rect
          key={`${x}:${y}`}
          x={x}
          y={y}
          width={1.02}
          height={1.02}
          fill={happyEyeKeys.has(`${x}:${y}`) ? FACE_FILL : fill}
        />
      ))}
      {eyes.map(([x, y]) => (
        <rect key={`eye-${x}:${y}`} x={x} y={y} width={1.02} height={1.02} fill={INK_FILL} />
      ))}
      {overlays.map((overlay, index) => (
        <g key={index} className={overlay.className} fill="currentColor">
          {overlay.pixels.map(([x, y]) => (
            <rect
              key={`${x}:${y}`}
              x={overlay.at[0] + x}
              y={overlay.at[1] + y}
              width={1.02}
              height={1.02}
            />
          ))}
        </g>
      ))}
    </svg>
  )
}
