/** Нижние превью всегда 16:9. */
export const VOICE_STAGE_STRIP_TILE_ASPECT = 16 / 9

const FOCUS_STACK_GAP_PX = 8
const FOCUS_MIN_HEIGHT_PX = 120
/** Кнопка «Показать превью» (28px) + зазор под фокусом (8px). */
const COLLAPSED_STRIP_CHROME_PX = 36
const STRIP_ROW_PADDING_PX = 8
const STRIP_TILE_GAP_PX = 8
const STRIP_TILE_MAX_WIDTH_PX = 224
const STRIP_TILE_MIN_WIDTH_PX = 128

export type VoiceStageFocusLayout = {
  focus: { width: number; height: number }
  stripTile: { width: number; height: number }
}

function stripTileWidthForContainer(
  containerWidth: number,
  stripCount: number,
): number {
  if (stripCount <= 0) return 0

  const available =
    containerWidth - STRIP_ROW_PADDING_PX - (stripCount - 1) * STRIP_TILE_GAP_PX

  const perTile = available / stripCount
  return Math.max(
    STRIP_TILE_MIN_WIDTH_PX,
    Math.min(STRIP_TILE_MAX_WIDTH_PX, perTile),
  )
}

function stripRowHeight(stripTileWidth: number): number {
  if (stripTileWidth <= 0) return 0
  return stripTileWidth / VOICE_STAGE_STRIP_TILE_ASPECT + STRIP_ROW_PADDING_PX
}

/** Вписывает прямоугольник заданных пропорций в бокс, максимизируя площадь. */
function fitAspectRatioInBox(
  boxWidth: number,
  boxHeight: number,
  aspectRatio: number,
): { width: number; height: number } {
  let width = boxWidth
  let height = width / aspectRatio

  if (height > boxHeight) {
    height = boxHeight
    width = height * aspectRatio
  }

  return { width, height }
}

function flooredSize(size: { width: number; height: number }) {
  return {
    width: Math.max(0, Math.floor(size.width)),
    height: Math.max(0, Math.floor(size.height)),
  }
}

/**
 * Раскладка фокус-режима: фокус-стрим максимально заполняет доступную площадь
 * (с сохранением своих пропорций), под ним резервируется ряд превью 16:9.
 *
 * Нет искусственного ограничения ширины — на широких экранах стрим занимает
 * всё доступное место, упираясь либо в ширину контейнера, либо в высоту,
 * оставшуюся после ленты превью.
 */
export function computeVoiceStageFocusLayout(
  containerWidth: number,
  containerHeight: number,
  streamAspectRatio: number,
  stripCount: number,
  collapsedStripChrome = false,
): VoiceStageFocusLayout {
  if (containerWidth <= 0 || containerHeight <= 0 || streamAspectRatio <= 0) {
    return {
      focus: { width: 0, height: 0 },
      stripTile: { width: 0, height: 0 },
    }
  }

  // Ленты нет (или она свёрнута): фокус занимает весь контейнер.
  if (stripCount <= 0) {
    const chromeHeight = collapsedStripChrome ? COLLAPSED_STRIP_CHROME_PX : 0
    const boxHeight = Math.max(
      FOCUS_MIN_HEIGHT_PX,
      containerHeight - chromeHeight,
    )
    const focus = fitAspectRatioInBox(containerWidth, boxHeight, streamAspectRatio)

    return {
      focus: flooredSize(focus),
      stripTile: { width: 0, height: 0 },
    }
  }

  // Лента снизу: резервируем под неё один ряд 16:9, остаток отдаём фокусу.
  const stripTileWidth = stripTileWidthForContainer(containerWidth, stripCount)
  const stripHeight = stripRowHeight(stripTileWidth)

  const focusBoxHeight = Math.max(
    FOCUS_MIN_HEIGHT_PX,
    containerHeight - stripHeight - FOCUS_STACK_GAP_PX,
  )
  const focus = fitAspectRatioInBox(
    containerWidth,
    focusBoxHeight,
    streamAspectRatio,
  )

  return {
    focus: flooredSize(focus),
    stripTile: {
      width: Math.max(0, Math.floor(stripTileWidth)),
      height: Math.max(0, Math.floor(stripTileWidth / VOICE_STAGE_STRIP_TILE_ASPECT)),
    },
  }
}
