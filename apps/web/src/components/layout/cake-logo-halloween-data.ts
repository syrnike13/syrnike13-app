/**
 * Seasonal pixel artwork for the Halloween loading scene.
 *
 * Coordinates use the same unit grid as the brand logo (20 × 26 cells), so
 * sprites can sit in the margins around the cake without changing the viewBox.
 * Colors are fixed artwork values, like the sampled brand pixels, and do not
 * depend on the active theme.
 */

export type PixelSprite = {
  readonly rows: readonly string[]
  readonly palette: Readonly<Record<string, string>>
}

export const HALLOWEEN_SPRITES = {
  /** Corner web that the spider uses as an anchor. */
  cobweb: {
    palette: { '#': '#c8c0d8' },
    rows: [
      '#######',
      '#...#.#',
      '#..##.#',
      '#.###.#',
      '##.#.#.',
      '#.#..#.',
      '##.....',
    ],
  },
  spider: {
    palette: { '#': '#241a2e', o: '#ff8a3d' },
    rows: ['#...#', '.###.', '##o##', '.###.', '#...#'],
  },
  bat: {
    palette: { '#': '#2a1c33' },
    rows: ['#.......#', '##.....##', '#########', '##.###.##', '#.#...#.#'],
  },
} as const satisfies Record<string, PixelSprite>
