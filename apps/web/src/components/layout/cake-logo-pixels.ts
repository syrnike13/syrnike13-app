/** Logo-shaped cells for seasonal set dressing that hugs the brand artwork. */
import { CAKE_PIXELS } from './cake-logo-data'

export type CakeCell = { readonly x: number; readonly y: number }

function topOfColumn(x: number) {
  return Math.min(
    ...CAKE_PIXELS.filter((pixel) => pixel.x === x).map((pixel) => pixel.y),
  )
}

/**
 * Snow resting on the logo: a layer above every column's top pixel, and a
 * second layer over the top pixel on every other column so it drips.
 */
export const SNOW_CAP: readonly CakeCell[] = Array.from({ length: 20 }, (_, x) => {
  const top = topOfColumn(x)
  if (!Number.isFinite(top)) return []
  return x % 2 === 0
    ? [
        { x, y: top - 1 },
        { x, y: top },
      ]
    : [{ x, y: top - 1 }]
}).flat()
