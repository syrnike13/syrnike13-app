import type { AnchorRect, HomageAnchorId, HomageKind, PlayRegion } from './types'

export const HOMAGE_ANCHOR_PRIORITY: Record<HomageKind, HomageAnchorId[]> = {
  sideShooter: ['download', 'header-cta'],
  snake: ['hero'],
  fallingBlock: ['download'],
  aliens: ['logo', 'download'],
  paddleBall: ['hero'],
  chomper: ['platforms', 'logo'],
}

export function collectAnchors(root: HTMLElement): Map<HomageAnchorId, AnchorRect> {
  const rootRect = root.getBoundingClientRect()
  const map = new Map<HomageAnchorId, AnchorRect>()

  root.ownerDocument.querySelectorAll('[data-homage-anchor]').forEach((node) => {
    const id = node.getAttribute('data-homage-anchor') as HomageAnchorId | null
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

function pickAnchor(
  kind: HomageKind,
  anchors: Map<HomageAnchorId, AnchorRect>,
): AnchorRect | null {
  for (const id of HOMAGE_ANCHOR_PRIORITY[kind]) {
    const anchor = anchors.get(id)
    if (anchor) return anchor
  }
  return anchors.values().next().value ?? null
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

export function buildPlayRegion(
  kind: HomageKind,
  anchors: Map<HomageAnchorId, AnchorRect>,
  viewW: number,
  viewH: number,
): PlayRegion | null {
  const anchor = pickAnchor(kind, anchors)
  if (!anchor) return null

  const pad = 16

  switch (kind) {
    case 'sideShooter': {
      const bandH = 72
      return {
        anchorId: anchor.id,
        x: 0,
        y: clamp(anchor.cy - bandH / 2, pad, viewH - bandH - pad),
        w: viewW,
        h: bandH,
      }
    }

    case 'snake': {
      const margin = 10
      const obstacles = [...anchors.values()].map((a) => ({
        x: a.x - margin - 6,
        y: a.y - margin - 6,
        w: a.w + 12,
        h: a.h + 12,
      }))
      return {
        anchorId: 'hero',
        x: margin,
        y: margin,
        w: viewW - margin * 2,
        h: viewH - margin * 2,
        obstacles,
        suppressHighlight: true,
      }
    }

    case 'fallingBlock': {
      const colW = 88
      const colH = Math.min(200, anchor.y - pad)
      if (colH < 80) return null
      return {
        anchorId: anchor.id,
        x: clamp(anchor.cx - colW / 2, pad, viewW - colW - pad),
        y: clamp(anchor.y - colH - 8, pad, viewH - colH - pad),
        w: colW,
        h: colH,
      }
    }

    case 'aliens': {
      const regionW = Math.min(viewW - pad * 2, Math.max(anchor.w + 140, 280))
      const regionH = 118
      const y = clamp(anchor.y - regionH - 12, pad, viewH - regionH - pad)
      return {
        anchorId: anchor.id,
        x: clamp(anchor.cx - regionW / 2, pad, viewW - regionW - pad),
        y,
        w: regionW,
        h: regionH,
      }
    }

    case 'paddleBall': {
      const hero = anchors.get('hero') ?? anchor
      const stripW = 56
      const leftSpace = hero.x - pad * 2
      const rightSpace = viewW - (hero.x + hero.w) - pad * 2
      const onLeft = leftSpace >= stripW + 20 || leftSpace >= rightSpace

      return {
        anchorId: 'hero',
        x: onLeft ? pad : viewW - stripW - pad,
        y: clamp(hero.y - 20, pad, viewH - hero.h - 40 - pad),
        w: stripW,
        h: Math.min(hero.h + 80, viewH - pad * 2),
      }
    }

    case 'chomper': {
      const regionH = 40
      const regionW = Math.min(viewW - pad * 2, Math.max(anchor.w + 80, 260))
      return {
        anchorId: anchor.id,
        x: clamp(anchor.cx - regionW / 2, pad, viewW - regionW - pad),
        y: clamp(anchor.cy - regionH / 2, pad, viewH - regionH - pad),
        w: regionW,
        h: regionH,
      }
    }
  }
}
