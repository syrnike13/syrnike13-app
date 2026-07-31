import type { File } from '@syrnike13/api-types'

import { imageFileAspectRatio } from '#/lib/media'

/** Ширина / высота; экстремумы режем как в Telegram. */
const MIN_RATIO = 0.45
const MAX_RATIO = 2.4
/** Зазор между плитками в % ширины контейнера. */
const GAP = 0.7

export type MosaicTileLayout = {
  index: number
  /** Доли контейнера, 0–100 */
  left: number
  top: number
  width: number
  height: number
}

export type MosaicLayoutResult = {
  /** width / height контейнера */
  aspectRatio: number
  tiles: MosaicTileLayout[]
}

type MosaicRow = {
  ratios: number[]
  indices: number[]
}

export function clampMosaicRatio(ratio: number) {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
}

export function fileMosaicRatio(file: File) {
  return clampMosaicRatio(imageFileAspectRatio(file) ?? 1)
}

function proportion(ratio: number): 'w' | 'n' | 'q' {
  if (ratio > 1.2) return 'w'
  if (ratio < 0.8) return 'n'
  return 'q'
}

/**
 * Умная мозаика вложений по aspect ratio (упрощённый Telegram album layout).
 * Координаты в процентах от размера контейнера.
 */
export function layoutAttachmentMosaic(ratios: number[]): MosaicLayoutResult {
  const r = ratios.map(clampMosaicRatio)
  const n = r.length
  if (n === 0) return { aspectRatio: 1, tiles: [] }
  if (n === 1) {
    return {
      aspectRatio: r[0]!,
      tiles: [{ index: 0, left: 0, top: 0, width: 100, height: 100 }],
    }
  }
  if (n === 2) return layoutTwo(r[0]!, r[1]!)
  if (n === 3) return layoutThree(r[0]!, r[1]!, r[2]!)
  if (n === 4) return layoutFour(r[0]!, r[1]!, r[2]!, r[3]!)
  return layoutComplex(r)
}

function layoutTwo(a: number, b: number): MosaicLayoutResult {
  // Две широкие — столбиком, сохраняя пропорции каждой.
  if (proportion(a) === 'w' && proportion(b) === 'w') {
    return stackRows([
      { ratios: [a], indices: [0] },
      { ratios: [b], indices: [1] },
    ])
  }
  return stackRows([{ ratios: [a, b], indices: [0, 1] }])
}

function layoutThree(a: number, b: number, c: number): MosaicLayoutResult {
  if (proportion(a) === 'w') {
    return stackRows([
      { ratios: [a], indices: [0] },
      { ratios: [b, c], indices: [1, 2] },
    ])
  }
  return layoutSidebar(a, 0, [
    { ratio: b, index: 1 },
    { ratio: c, index: 2 },
  ])
}

function layoutFour(
  a: number,
  b: number,
  c: number,
  d: number,
): MosaicLayoutResult {
  if (proportion(a) === 'w') {
    return stackRows([
      { ratios: [a], indices: [0] },
      { ratios: [b, c, d], indices: [1, 2, 3] },
    ])
  }

  const props = [a, b, c, d].map(proportion).join('')
  if (/^[nq]{4}$/.test(props)) {
    return stackRows([
      { ratios: [a, b], indices: [0, 1] },
      { ratios: [c, d], indices: [2, 3] },
    ])
  }

  return layoutSidebar(a, 0, [
    { ratio: b, index: 1 },
    { ratio: c, index: 2 },
    { ratio: d, index: 3 },
  ])
}

function stackRows(rows: MosaicRow[]): MosaicLayoutResult {
  const rowHeights = rows.map(
    (row) => 100 / row.ratios.reduce((sum, ratio) => sum + ratio, 0),
  )
  const totalHeight =
    rowHeights.reduce((sum, height) => sum + height, 0) +
    GAP * Math.max(0, rows.length - 1)

  const tiles: MosaicTileLayout[] = []
  let y = 0

  rows.forEach((row, rowIndex) => {
    const rowHeight = rowHeights[rowIndex]!
    const ratioSum = row.ratios.reduce((sum, ratio) => sum + ratio, 0)
    const gapsWidth = GAP * Math.max(0, row.ratios.length - 1)
    const usableWidth = 100 - gapsWidth
    let x = 0

    row.ratios.forEach((ratio, itemIndex) => {
      const width = (ratio / ratioSum) * usableWidth
      tiles.push({
        index: row.indices[itemIndex]!,
        left: x,
        top: (y / totalHeight) * 100,
        width,
        height: (rowHeight / totalHeight) * 100,
      })
      x += width + GAP
    })

    y += rowHeight + (rowIndex < rows.length - 1 ? GAP : 0)
  })

  return {
    aspectRatio: 100 / totalHeight,
    tiles,
  }
}

function layoutSidebar(
  primaryRatio: number,
  primaryIndex: number,
  secondary: Array<{ ratio: number; index: number }>,
): MosaicLayoutResult {
  const secondaryInvSum = secondary.reduce(
    (sum, item) => sum + 1 / item.ratio,
    0,
  )
  const secondaryGaps = GAP * Math.max(0, secondary.length - 1)
  // Высоты совпадают: Wp/Rp = Ws * Σ(1/Ri) + gaps
  // Wp + Ws + GAP = 100
  const numer = 100 - GAP - primaryRatio * secondaryGaps
  const denom = 1 + primaryRatio * secondaryInvSum
  const secondaryWidth = Math.min(64, Math.max(30, numer / denom))
  const primaryWidth = 100 - GAP - secondaryWidth
  const height = primaryWidth / primaryRatio

  const rightHeights = secondary.map((item) => secondaryWidth / item.ratio)
  const rightTotal =
    rightHeights.reduce((sum, value) => sum + value, 0) + secondaryGaps

  const tiles: MosaicTileLayout[] = [
    {
      index: primaryIndex,
      left: 0,
      top: 0,
      width: primaryWidth,
      height: 100,
    },
  ]

  let top = 0
  secondary.forEach((item, index) => {
    const tileHeight = (rightHeights[index]! / rightTotal) * 100
    tiles.push({
      index: item.index,
      left: primaryWidth + GAP,
      top,
      width: secondaryWidth,
      height: tileHeight,
    })
    top += tileHeight + (index < secondary.length - 1 ? GAP : 0)
  })

  return {
    aspectRatio: 100 / height,
    tiles,
  }
}

function layoutComplex(ratios: number[]): MosaicLayoutResult {
  const attempts = partitionAttempts(ratios.length)
  let best = attempts[0] ?? [ratios.length]
  let bestDiff = Number.POSITIVE_INFINITY

  for (const lineCounts of attempts) {
    let offset = 0
    let totalHeight = 0
    for (const count of lineCounts) {
      const sum = ratios
        .slice(offset, offset + count)
        .reduce((acc, ratio) => acc + ratio, 0)
      totalHeight += 1 / sum
      offset += count
    }
    totalHeight += (GAP / 100) * Math.max(0, lineCounts.length - 1)
    const diff = Math.abs(totalHeight - 4 / 3)
    if (diff < bestDiff) {
      bestDiff = diff
      best = lineCounts
    }
  }

  const rows: MosaicRow[] = []
  let offset = 0
  for (const count of best) {
    rows.push({
      ratios: ratios.slice(offset, offset + count),
      indices: Array.from({ length: count }, (_, index) => offset + index),
    })
    offset += count
  }
  return stackRows(rows)
}

function partitionAttempts(count: number): number[][] {
  const result: number[][] = []

  const walk = (remaining: number, current: number[]) => {
    if (remaining === 0) {
      result.push(current)
      return
    }
    for (let size = Math.min(3, remaining); size >= 1; size -= 1) {
      if (remaining - size === 1 && size > 1) continue
      walk(remaining - size, [...current, size])
    }
  }

  walk(count, [])
  return result.length > 0 ? result : [[count]]
}
