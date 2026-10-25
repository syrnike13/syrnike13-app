import { SNOW_CAP } from './cake-logo-pixels'
import { Sprite, type PixelSprite, type SceneStyle } from './cake-logo-sprite'

const SNOW = '#eef4fb'
const LIGHTS = ['#ff5a5f', '#ffd34d', '#5ab8ff'] as const

const SPRITES = {
  tree: {
    palette: { g: '#2f8f57', G: '#1f6b42', t: '#7a4b2a' },
    rows: [
      '....g....',
      '...ggg...',
      '..gGggg..',
      '...ggg...',
      '..ggGgg..',
      '.ggggGgg.',
      '..ggggg..',
      '.gGggggg.',
      'gggggGggg',
      '.ggggggg.',
      'ggGgggggG',
      'ggggggggg',
      '....t....',
      '....t....',
    ],
  },
  star: {
    palette: { s: '#ffd34d', S: '#fff2b0' },
    rows: ['..s..', '.sSs.', 'sSSSs', '.s.s.'],
  },
  gift: {
    palette: { r: '#e5484d', R: '#b8333a', y: '#ffd34d' },
    rows: [
      '.yy..yy.',
      '..y..y..',
      '...yy...',
      'RRRyyRRR',
      'rrryyrrR',
      'yyyyyyyy',
      'rrryyrrR',
      'rrryyrrR',
    ],
  },
  smallGift: {
    palette: { b: '#3d8bfd', B: '#2a63b8', w: SNOW },
    rows: ['.w.w.', '..w..', 'BBwBB', 'bbwbB', 'wwwww', 'bbwbB'],
  },
} as const satisfies Record<string, PixelSprite>

/** Tree lights as cells on the tree sprite; `group` picks the blink phase. */
const TREE_LIGHTS = [
  { x: 3, y: 2, group: 0 },
  { x: 5, y: 4, group: 1 },
  { x: 2, y: 5, group: 2 },
  { x: 6, y: 6, group: 0 },
  { x: 3, y: 7, group: 1 },
  { x: 7, y: 8, group: 2 },
  { x: 1, y: 8, group: 0 },
  { x: 4, y: 9, group: 2 },
  { x: 6, y: 10, group: 1 },
  { x: 2, y: 11, group: 0 },
  { x: 8, y: 11, group: 2 },
] as const

const TREE = { x: -11, y: 12 }

/** Flakes: position, size (dot or plus), fall time and phase in seconds. */
const SNOWFLAKES = [
  { x: -10, y: 2, size: 1, duration: 5.2, delay: -1.1 },
  { x: -6, y: 18, size: 3, duration: 6.4, delay: -4.3 },
  { x: -2, y: 8, size: 1, duration: 4.6, delay: -2.4 },
  { x: 2, y: -2, size: 1, duration: 5.8, delay: -0.3 },
  { x: 5, y: 12, size: 3, duration: 7.1, delay: -5.2 },
  { x: 9, y: 4, size: 1, duration: 4.9, delay: -3.6 },
  { x: 12, y: 20, size: 1, duration: 6.1, delay: -1.9 },
  { x: 15, y: 1, size: 3, duration: 6.8, delay: -2.8 },
  { x: 18, y: 15, size: 1, duration: 5.4, delay: -4.8 },
  { x: 21, y: 6, size: 1, duration: 4.7, delay: -0.9 },
  { x: 24, y: 11, size: 3, duration: 6.6, delay: -3.1 },
  { x: 27, y: -1, size: 1, duration: 5.1, delay: -2.2 },
  { x: 30, y: 9, size: 1, duration: 5.9, delay: -5.6 },
] as const

/** Snow drift along the ground line under the scene. */
const DRIFT: PixelSprite = {
  palette: { '#': SNOW },
  rows: [
    '..####......######.....#####.......#####....',
    '############################################',
  ],
}

function Snowflake({ x, y, size, duration, delay }: (typeof SNOWFLAKES)[number]) {
  const style: SceneStyle = {
    '--snow-from': `${-6 - y}px`,
    '--snow-to': `${30 - y}px`,
    '--snow-duration': `${duration}s`,
    '--snow-delay': `${delay}s`,
  }
  return (
    <g className="cake-snowflake" style={style}>
      {size === 1 ? (
        <rect x={x} y={y} width={1} height={1} fill={SNOW} />
      ) : (
        <path d={`M${x} ${y - 1}h1v1h1v1h-1v1h-1v-1h-1v-1h1z`} fill={SNOW} />
      )}
    </g>
  )
}

/**
 * New Year around a whole logo: snow lies on the syrnik, a fir tree with
 * blinking lights and presents stand beside it and snow keeps falling.
 */
export function NewYearScene() {
  return (
    <g className="cake-scene" aria-hidden="true">
      <Sprite sprite={SPRITES.tree} x={TREE.x} y={TREE.y} />
      {TREE_LIGHTS.map((light) => (
        <rect
          key={`${light.x}:${light.y}`}
          className="cake-light"
          data-group={light.group}
          x={TREE.x + light.x}
          y={TREE.y + light.y}
          width={1}
          height={1}
          fill={LIGHTS[light.group]}
        />
      ))}
      <Sprite sprite={SPRITES.star} x={TREE.x + 2} y={TREE.y - 4} className="cake-star" />
      <Sprite sprite={SPRITES.gift} x={20} y={18} />
      <Sprite sprite={SPRITES.smallGift} x={28} y={20} />
      <Sprite sprite={DRIFT} x={-12} y={26} />
      <g>
        {SNOW_CAP.map(({ x, y }) => (
          <rect key={`${x}:${y}`} x={x} y={y} width={1} height={1} fill={SNOW} />
        ))}
      </g>
      {SNOWFLAKES.map((flake) => (
        <Snowflake key={`${flake.x}:${flake.y}`} {...flake} />
      ))}
    </g>
  )
}
