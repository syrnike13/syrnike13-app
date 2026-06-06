export type HomageKind = 'sideShooter' | 'snake' | 'paddleBall'

export type HomageAnchorId = 'logo' | 'download' | 'platforms' | 'header-cta' | 'hero'

export interface AnchorRect {
  id: HomageAnchorId
  x: number
  y: number
  w: number
  h: number
  cx: number
  cy: number
}

export interface ObstacleRect {
  x: number
  y: number
  w: number
  h: number
}

export interface PlayRegion {
  anchorId: HomageAnchorId
  x: number
  y: number
  w: number
  h: number
  /** Препятствия в локальных координатах региона. */
  obstacles?: ObstacleRect[]
  /** Якоря UI в локальных координатах региона. */
  anchors?: AnchorRect[]
  /** Не подсвечивать якорный DOM-элемент во время сцены. */
  suppressHighlight?: boolean
}

export interface Scene {
  anchorId: HomageAnchorId
  tick: (dt: number) => void
  draw: (ctx: CanvasRenderingContext2D) => void
}
