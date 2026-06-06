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
