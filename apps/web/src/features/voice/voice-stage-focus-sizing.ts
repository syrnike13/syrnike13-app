/** Макс. ширина фокус-стрима (не на весь ультраширокий канал). */
export const VOICE_STAGE_FOCUS_MAX_WIDTH_PX = 1200

/** Нижние превью всегда 16:9. */
export const VOICE_STAGE_STRIP_TILE_ASPECT = 16 / 9

const FOCUS_STACK_GAP_PX = 8
const FOCUS_MIN_HEIGHT_PX = 120
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

/** @deprecated use computeVoiceStageFocusLayout */
export function computeVoiceStageFocusSize(
  containerWidth: number,
  containerHeight: number,
  aspectRatio: number,
  hasFilmstrip: boolean,
): { width: number; height: number } {
  return computeVoiceStageFocusLayout(
    containerWidth,
    containerHeight,
    aspectRatio,
    hasFilmstrip ? 2 : 0,
  ).focus
}

export function computeVoiceStageFocusLayout(
  containerWidth: number,
  containerHeight: number,
  streamAspectRatio: number,
  stripCount: number,
): VoiceStageFocusLayout {
  if (containerWidth <= 0 || containerHeight <= 0 || streamAspectRatio <= 0) {
    return {
      focus: { width: 0, height: 0 },
      stripTile: { width: 0, height: 0 },
    }
  }

  const widthCap = Math.min(containerWidth, VOICE_STAGE_FOCUS_MAX_WIDTH_PX)
  let stripTileWidth = stripTileWidthForContainer(containerWidth, stripCount)
  let stripHeight = stripRowHeight(stripTileWidth)

  let focusZoneHeight = Math.max(
    FOCUS_MIN_HEIGHT_PX,
    containerHeight - stripHeight - FOCUS_STACK_GAP_PX,
  )

  let focusWidth = widthCap
  let focusHeight = focusWidth / streamAspectRatio

  if (focusHeight > focusZoneHeight) {
    focusHeight = focusZoneHeight
    focusWidth = focusHeight * streamAspectRatio
  }

  focusWidth = Math.min(focusWidth, widthCap)

  const totalStack =
    focusHeight + FOCUS_STACK_GAP_PX + stripHeight

  if (totalStack > containerHeight && stripCount > 0) {
    focusZoneHeight = Math.max(
      FOCUS_MIN_HEIGHT_PX,
      containerHeight * 0.58 - FOCUS_STACK_GAP_PX,
    )
    focusHeight = Math.min(focusHeight, focusZoneHeight)
    focusWidth = Math.min(focusHeight * streamAspectRatio, widthCap)

    const stripBudget = Math.max(
      0,
      containerHeight - focusHeight - FOCUS_STACK_GAP_PX - STRIP_ROW_PADDING_PX,
    )
    stripTileWidth = Math.min(
      stripTileWidthForContainer(containerWidth, stripCount),
      stripBudget * VOICE_STAGE_STRIP_TILE_ASPECT,
    )
    stripTileWidth = Math.max(STRIP_TILE_MIN_WIDTH_PX, stripTileWidth)
    stripHeight = stripRowHeight(stripTileWidth)
  }

  const stripTileHeight = stripTileWidth / VOICE_STAGE_STRIP_TILE_ASPECT

  return {
    focus: {
      width: Math.max(0, Math.floor(focusWidth)),
      height: Math.max(0, Math.floor(focusHeight)),
    },
    stripTile: {
      width: Math.max(0, Math.floor(stripTileWidth)),
      height: Math.max(0, Math.floor(stripTileHeight)),
    },
  }
}
