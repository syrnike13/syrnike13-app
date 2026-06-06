import type { AnchorRect, HomageKind, PlayRegion } from './types'

const MARGIN = 10
const OBSTACLE_PAD = 8

export function collectAnchors(root: HTMLElement): Map<AnchorRect['id'], AnchorRect> {
  const rootRect = root.getBoundingClientRect()
  const map = new Map<AnchorRect['id'], AnchorRect>()

  root.ownerDocument.querySelectorAll('[data-homage-anchor]').forEach((node) => {
    const id = node.getAttribute('data-homage-anchor') as AnchorRect['id'] | null
    if (!id) return

    const r = node.getBoundingClientRect()
    map.set(id, {
      id,
      x: r.left - rootRect.left,
      y: r.top - rootRect.top,
      w: r.width,
      h: r.height,
      cx: r.left - rootRect.left + r.width / 2,
      cy: r.top - rootRect.top + r.height / 2,
    })
  })

  return map
}

function toLocalAnchors(
  anchors: Map<AnchorRect['id'], AnchorRect>,
  originX: number,
  originY: number,
): AnchorRect[] {
  return [...anchors.values()].map((a) => ({
    ...a,
    x: a.x - originX,
    y: a.y - originY,
    cx: a.cx - originX,
    cy: a.cy - originY,
  }))
}

function toObstacles(anchors: Map<AnchorRect['id'], AnchorRect>, originX: number, originY: number) {
  return [...anchors.values()].map((a) => ({
    x: a.x - originX - OBSTACLE_PAD,
    y: a.y - originY - OBSTACLE_PAD,
    w: a.w + OBSTACLE_PAD * 2,
    h: a.h + OBSTACLE_PAD * 2,
  }))
}

/** Все сцены играют на весь viewport; якоря — только для коллизий и поведения. */
export function buildPlayRegion(
  _kind: HomageKind,
  anchors: Map<AnchorRect['id'], AnchorRect>,
  viewW: number,
  viewH: number,
): PlayRegion | null {
  if (viewW < 120 || viewH < 120) return null

  return {
    anchorId: 'hero',
    x: MARGIN,
    y: MARGIN,
    w: viewW - MARGIN * 2,
    h: viewH - MARGIN * 2,
    obstacles: toObstacles(anchors, MARGIN, MARGIN),
    anchors: toLocalAnchors(anchors, MARGIN, MARGIN),
    suppressHighlight: true,
  }
}
