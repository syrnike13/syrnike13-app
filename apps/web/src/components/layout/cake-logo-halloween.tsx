import { Sprite, type PixelSprite } from './cake-logo-sprite'

const BAT = { '#': '#8a66c2', e: '#ffb347' }
const PUMPKIN = { s: '#6c8f2e', o: '#f28c28', d: '#c8611a', h: '#ffb05c' }

const SPRITES = {
  moon: {
    palette: { m: '#f6e7a8' },
    rows: [
      '..mmm..',
      '.mm....',
      'mm.....',
      'mm.....',
      'mm.....',
      '.mm....',
      '..mmm..',
    ],
  },
  /** Wing frames swap to flap; both share one origin. */
  batUp: {
    palette: BAT,
    rows: ['#.......#', '##.#.#.##', '.##e#e##.', '...###...', '....#....'],
  },
  batDown: {
    palette: BAT,
    rows: ['.........', '...#.#...', '.##e#e##.', '#########', '#...#...#'],
  },
  jackOLantern: {
    palette: PUMPKIN,
    rows: [
      '.....s.....',
      '....ss.....',
      '...ooooo...',
      '.oodooodoo.',
      'ohodooodood',
      'ohodooodood',
      'ohodooodood',
      'ooodooodood',
      '.oodooodoo.',
      '..ddddddd..',
    ],
  },
  /** Carved face over the lantern; it flickers like a candle. */
  lanternFace: {
    palette: { f: '#ffd45c' },
    rows: [
      '...........',
      '...........',
      '...........',
      '...........',
      '..ff...ff..',
      '..f.....f..',
      '.....f.....',
      '..fffffff..',
      '...f.f.f...',
      '...........',
    ],
  },
  smallPumpkin: {
    palette: PUMPKIN,
    rows: ['...s...', '..ss...', '.ooooo.', 'ohodood', 'ohodood', '.ddddd.'],
  },
} as const satisfies Record<string, PixelSprite>

function TwoFrames({
  a,
  b,
  className,
  data,
}: {
  a: PixelSprite
  b: PixelSprite
  className: string
  data?: string
}) {
  return (
    <g className={className} data-flight={data}>
      <Sprite sprite={a} x={0} y={0} className="cake-frame-a" />
      <Sprite sprite={b} x={0} y={0} className="cake-frame-b" />
    </g>
  )
}

/**
 * Halloween around a whole logo: a crescent moon, a flickering
 * jack-o'-lantern and a small pumpkin by the syrnik, and bats flapping
 * overhead.
 */
export function HalloweenScene() {
  return (
    <g className="cake-scene" aria-hidden="true">
      <Sprite sprite={SPRITES.moon} x={-11} y={-3} className="cake-moon" />
      <Sprite sprite={SPRITES.smallPumpkin} x={-8} y={20} />
      <Sprite sprite={SPRITES.jackOLantern} x={21} y={16} />
      <Sprite sprite={SPRITES.lanternFace} x={21} y={16} className="cake-lantern" />
      <TwoFrames a={SPRITES.batUp} b={SPRITES.batDown} className="cake-bat" data="high" />
      <TwoFrames a={SPRITES.batUp} b={SPRITES.batDown} className="cake-bat" data="late" />
    </g>
  )
}
