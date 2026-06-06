export type Sprite = readonly (readonly number[])[]

export function drawSprite(
  ctx: CanvasRenderingContext2D,
  sprite: Sprite,
  x: number,
  y: number,
  scale: number,
  color: string,
) {
  ctx.fillStyle = color
  for (let row = 0; row < sprite.length; row++) {
    const line = sprite[row]!
    for (let col = 0; col < line.length; col++) {
      if (line[col]) ctx.fillRect(x + col * scale, y + row * scale, scale, scale)
    }
  }
}

export function drawSpriteTinted(
  ctx: CanvasRenderingContext2D,
  sprite: Sprite,
  x: number,
  y: number,
  scale: number,
  fill: string,
  shadow?: string,
) {
  if (shadow) drawSprite(ctx, sprite, x + scale, y + scale, scale, shadow)
  drawSprite(ctx, sprite, x, y, scale, fill)
}

/** Vic Viper–style fighter, nose right */
export const SHIP_SPRITE: Sprite = [
  [0, 0, 0, 0, 1, 1, 0, 0],
  [0, 0, 0, 1, 1, 1, 1, 0],
  [0, 0, 1, 1, 1, 1, 1, 1],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [1, 1, 1, 1, 1, 1, 0, 0],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [0, 0, 1, 1, 1, 1, 1, 1],
  [0, 0, 0, 1, 1, 1, 1, 0],
]

export const ENEMY_SPRITE: Sprite = [
  [0, 0, 1, 0, 0, 1, 0, 0],
  [0, 1, 0, 1, 1, 0, 1, 0],
  [1, 1, 1, 1, 1, 1, 1, 1],
  [1, 0, 1, 1, 1, 1, 0, 1],
  [1, 1, 0, 0, 0, 0, 1, 1],
  [0, 0, 1, 1, 1, 1, 0, 0],
]

export const INVADER_A: Sprite = [
  [0, 0, 1, 0, 0, 0, 0, 1, 0, 0],
  [0, 0, 0, 1, 0, 0, 1, 0, 0, 0],
  [0, 0, 1, 1, 1, 1, 1, 1, 0, 0],
  [0, 1, 1, 0, 1, 1, 0, 1, 1, 0],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 0, 1, 1, 1, 1, 1, 1, 0, 1],
  [1, 0, 1, 0, 0, 0, 0, 1, 0, 1],
  [0, 0, 0, 1, 1, 0, 1, 1, 0, 0],
]

export const INVADER_B: Sprite = [
  [0, 0, 0, 1, 0, 0, 1, 0, 0, 0],
  [0, 0, 1, 0, 1, 1, 0, 1, 0, 0],
  [0, 0, 1, 1, 1, 1, 1, 1, 0, 0],
  [0, 1, 1, 0, 1, 1, 0, 1, 1, 0],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [0, 1, 0, 1, 1, 1, 1, 0, 1, 0],
  [1, 0, 0, 0, 1, 1, 0, 0, 0, 1],
  [0, 1, 0, 0, 0, 0, 0, 0, 1, 0],
]

export const CANNON_SPRITE: Sprite = [
  [0, 0, 0, 1, 1, 0, 0, 0],
  [0, 0, 1, 1, 1, 1, 0, 0],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [1, 1, 1, 1, 1, 1, 1, 1],
]

export const SNAKE_HEAD: Sprite = [
  [0, 1, 1, 1, 1],
  [1, 1, 1, 1, 1],
  [1, 1, 0, 1, 1],
  [1, 1, 1, 1, 1],
  [0, 1, 1, 1, 1],
]

export const SNAKE_BODY: Sprite = [
  [0, 1, 1, 1, 0],
  [1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1],
  [0, 1, 1, 1, 0],
]

export const GHOST_SPRITE: Sprite = [
  [0, 0, 1, 1, 1, 1, 0, 0],
  [0, 1, 1, 1, 1, 1, 1, 0],
  [1, 1, 1, 1, 1, 1, 1, 1],
  [1, 0, 1, 1, 1, 1, 0, 1],
  [1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1],
  [1, 0, 1, 0, 1, 0, 1, 0],
  [1, 0, 1, 0, 1, 0, 1, 0],
]

export const TETRIS_L: Sprite = [
  [1, 0],
  [1, 0],
  [1, 1],
]

export const TETRIS_T: Sprite = [
  [0, 1, 0],
  [1, 1, 1],
]

export const TETRIS_I: Sprite = [[1], [1], [1], [1]]

export function drawBlock(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  fill: string,
  edge: string,
) {
  ctx.fillStyle = fill
  ctx.fillRect(x, y, size - 1, size - 1)
  ctx.fillStyle = edge
  ctx.fillRect(x, y, size - 1, 1)
  ctx.fillRect(x, y, 1, size - 1)
}

export function drawPacMan(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  mouth: number,
  facingRight: boolean,
) {
  const open = 0.18 + Math.abs(Math.sin(mouth * Math.PI * 2)) * 0.42
  const start = facingRight ? open * Math.PI : Math.PI + open * Math.PI
  const end = facingRight ? (2 - open) * Math.PI : Math.PI - open * Math.PI

  ctx.fillStyle = 'rgba(255, 210, 40, 0.82)'
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.arc(x, y, radius, start, end)
  ctx.closePath()
  ctx.fill()
}
