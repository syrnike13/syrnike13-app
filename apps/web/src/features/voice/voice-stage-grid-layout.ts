/**
 * Динамическая раскладка плиточной сетки стейджа в духе Discord.
 *
 * Идея: для контейнера W×H и N плиток перебираем число колонок и выбираем
 * вариант, дающий максимальную площадь плитки при фиксированном соотношении
 * сторон. Все плитки одинаковые, последний неполный ряд центрируется.
 *
 * Если даже при минимальном размере плитки всё не вмещается по высоте —
 * переходим в режим вертикального скролла (`scroll: true`).
 */

/** Зазор между плитками, px (как у Discord). */
export const VOICE_STAGE_GRID_GAP_PX = 8

/** Все плитки сетки — 16:9. */
export const VOICE_STAGE_GRID_TILE_ASPECT = 16 / 9

/** Минимальная ширина плитки до перехода в скролл, px. */
export const VOICE_STAGE_GRID_MIN_TILE_WIDTH_PX = 168

export type VoiceStageGridLayout = {
  /** Число колонок (плиток в полном ряду). */
  columns: number
  /** Число рядов. */
  rows: number
  /** Ширина плитки, px. */
  tileWidth: number
  /** Высота плитки, px. */
  tileHeight: number
  /** Зазор между плитками, px. */
  gap: number
  /** Контент не вмещается по высоте — нужен вертикальный скролл. */
  scroll: boolean
}

export const EMPTY_VOICE_STAGE_GRID_LAYOUT: VoiceStageGridLayout = {
  columns: 0,
  rows: 0,
  tileWidth: 0,
  tileHeight: 0,
  gap: VOICE_STAGE_GRID_GAP_PX,
  scroll: false,
}

export type ComputeVoiceStageGridLayoutParams = {
  width: number
  height: number
  count: number
  gap?: number
  aspectRatio?: number
  minTileWidth?: number
}

/**
 * Раскладки с площадью плитки в пределах этого допуска от максимума считаем
 * равноценными и среди них выбираем визуально лучшую (более «горизонтальную»,
 * с лучше заполненным последним рядом) — как делает Discord.
 */
const AREA_TOLERANCE = 0.05

function fitTileInCell(
  cellWidth: number,
  cellHeight: number,
  aspectRatio: number,
): { width: number; height: number } {
  if (cellWidth / cellHeight > aspectRatio) {
    const height = cellHeight
    return { width: height * aspectRatio, height }
  }
  const width = cellWidth
  return { width, height: width / aspectRatio }
}

export function computeVoiceStageGridLayout({
  width,
  height,
  count,
  gap = VOICE_STAGE_GRID_GAP_PX,
  aspectRatio = VOICE_STAGE_GRID_TILE_ASPECT,
  minTileWidth = VOICE_STAGE_GRID_MIN_TILE_WIDTH_PX,
}: ComputeVoiceStageGridLayoutParams): VoiceStageGridLayout {
  if (count <= 0 || width <= 0 || height <= 0 || aspectRatio <= 0) {
    return EMPTY_VOICE_STAGE_GRID_LAYOUT
  }

  type Candidate = {
    columns: number
    rows: number
    tileWidth: number
    tileHeight: number
    area: number
    emptyCells: number
  }

  const candidates: Candidate[] = []

  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns)
    const cellWidth = (width - (columns - 1) * gap) / columns
    const cellHeight = (height - (rows - 1) * gap) / rows
    if (cellWidth <= 0 || cellHeight <= 0) continue

    const tile = fitTileInCell(cellWidth, cellHeight, aspectRatio)
    candidates.push({
      columns,
      rows,
      tileWidth: tile.width,
      tileHeight: tile.height,
      area: tile.width * tile.height,
      emptyCells: columns * rows - count,
    })
  }

  const maxArea = candidates.reduce((max, item) => Math.max(max, item.area), 0)

  // Среди почти равных по площади выбираем более «горизонтальную» раскладку
  // с лучше заполненным последним рядом (меньше рядов → меньше пустых ячеек).
  const best = candidates
    .filter((item) => item.area >= maxArea * (1 - AREA_TOLERANCE))
    .sort(
      (a, b) =>
        a.rows - b.rows ||
        a.emptyCells - b.emptyCells ||
        b.area - a.area,
    )[0]

  // Лучший вариант слишком мелкий — фиксируем минимальную ширину и скроллим.
  if (!best || best.tileWidth < minTileWidth) {
    const columns = Math.max(
      1,
      Math.min(count, Math.floor((width + gap) / (minTileWidth + gap))),
    )
    const rows = Math.ceil(count / columns)
    const tileWidth = (width - (columns - 1) * gap) / columns
    const tileHeight = tileWidth / aspectRatio
    const contentHeight = rows * tileHeight + (rows - 1) * gap

    return {
      columns,
      rows,
      tileWidth: Math.max(0, Math.floor(tileWidth)),
      tileHeight: Math.max(0, Math.floor(tileHeight)),
      gap,
      scroll: contentHeight > height + 1,
    }
  }

  return {
    columns: best.columns,
    rows: best.rows,
    tileWidth: Math.max(0, Math.floor(best.tileWidth)),
    tileHeight: Math.max(0, Math.floor(best.tileHeight)),
    gap,
    scroll: false,
  }
}

/** Разбивает плоский список на ряды по `columns` элементов. */
export function chunkIntoRows<T>(items: readonly T[], columns: number): T[][] {
  if (columns <= 0) return items.length > 0 ? [[...items]] : []
  const rows: T[][] = []
  for (let index = 0; index < items.length; index += columns) {
    rows.push(items.slice(index, index + columns))
  }
  return rows
}
