import {
  CANNON_SPRITE,
  drawBlock,
  drawPacMan,
  drawSpriteTinted,
  ENEMY_SPRITE,
  GHOST_SPRITE,
  INVADER_A,
  INVADER_B,
  SHIP_SPRITE,
  SNAKE_BODY,
  SNAKE_HEAD,
  TETRIS_I,
  TETRIS_L,
  TETRIS_T,
} from './sprites'
import type { AnchorRect, HomageKind, PlayRegion, Scene } from './types'

const PX = 2

function withRegion(
  region: PlayRegion,
  anchor: AnchorRect | undefined,
  factory: (local: PlayRegion, anchor?: AnchorRect) => Scene,
): Scene {
  const scene = factory(region, anchor)
  return {
    anchorId: region.anchorId,
    tick: scene.tick,
    draw(ctx) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(region.x, region.y, region.w, region.h)
      ctx.clip()
      ctx.translate(region.x, region.y)
      scene.draw(ctx)
      ctx.restore()
    },
  }
}

export function createScene(
  kind: HomageKind,
  region: PlayRegion,
  anchor?: AnchorRect,
): Scene {
  switch (kind) {
    case 'sideShooter':
      return withRegion(region, anchor, createSideShooter)
    case 'snake':
      return withRegion(region, anchor, createSnake)
    case 'fallingBlock':
      return withRegion(region, anchor, createFallingBlock)
    case 'aliens':
      return withRegion(region, anchor, createAliens)
    case 'paddleBall':
      return withRegion(region, anchor, createPaddleBall)
    case 'chomper':
      return withRegion(region, anchor, createChomper)
  }
}

/** Horizontal fly-by along the download button row */
function createSideShooter(local: PlayRegion, anchor?: AnchorRect): Scene {
  const targetX = anchor ? anchor.cx - local.x : local.w * 0.62
  const stars = Array.from({ length: 48 }, () => ({
    x: Math.random() * local.w,
    y: Math.random() * local.h,
    s: 0.5 + Math.random(),
  }))
  const bullets: { x: number; y: number }[] = []
  const enemies: { x: number; y: number; hp: number }[] = []
  let shipY = local.h / 2
  let t = 0
  let shootCd = 0
  let spawnCd = 400

  return {
    anchorId: local.anchorId,
    tick(dt) {
      t += dt
      shipY = local.h / 2 + Math.sin(t * 0.0025) * (local.h * 0.28)
      shootCd -= dt
      spawnCd -= dt

      for (const star of stars) {
        star.x -= star.s * 0.08 * dt
        if (star.x < -2) {
          star.x = local.w + 2
          star.y = Math.random() * local.h
        }
      }

      if (shootCd <= 0) {
        bullets.push({ x: 28, y: shipY + 6 })
        shootCd = 220
      }

      if (spawnCd <= 0) {
        enemies.push({
          x: local.w + 20,
          y: 12 + Math.random() * (local.h - 28),
          hp: 1,
        })
        spawnCd = 700 + Math.random() * 500
      }

      for (const b of bullets) b.x += 0.42 * dt
      for (const e of enemies) e.x -= 0.14 * dt

      for (const b of bullets) {
        for (const e of enemies) {
          if (e.hp <= 0) continue
          if (
            b.x > e.x &&
            b.x < e.x + ENEMY_SPRITE[0]!.length * PX &&
            b.y > e.y &&
            b.y < e.y + ENEMY_SPRITE.length * PX
          ) {
            e.hp = 0
            b.x = local.w + 100
          }
        }
      }

      bullets.splice(0, bullets.length, ...bullets.filter((b) => b.x < local.w + 20))
      enemies.splice(0, enemies.length, ...enemies.filter((e) => e.hp > 0 && e.x > -30))
    },
    draw(ctx) {
      ctx.fillStyle = 'rgba(255,255,255,0.12)'
      for (const star of stars) ctx.fillRect(star.x, star.y, 1, 1)

      drawSpriteTinted(
        ctx,
        SHIP_SPRITE,
        14,
        shipY,
        PX,
        'rgba(170, 210, 255, 0.75)',
        'rgba(40, 70, 140, 0.25)',
      )

      ctx.fillStyle = 'rgba(255, 220, 90, 0.85)'
      for (const b of bullets) ctx.fillRect(b.x, b.y, 10, 2)

      for (const e of enemies) {
        drawSpriteTinted(
          ctx,
          ENEMY_SPRITE,
          e.x,
          e.y,
          PX,
          'rgba(255, 110, 110, 0.7)',
          'rgba(120, 20, 20, 0.3)',
        )
      }

      if (anchor) {
        const markerX = targetX
        ctx.strokeStyle = 'rgba(255,255,255,0.08)'
        ctx.setLineDash([3, 5])
        ctx.beginPath()
        ctx.moveTo(markerX, 0)
        ctx.lineTo(markerX, local.h)
        ctx.stroke()
        ctx.setLineDash([])
      }
    },
  }
}

function buildObstacleGrid(
  obstacles: PlayRegion['obstacles'],
  cell: number,
  cols: number,
  rows: number,
) {
  const blocked = Array.from({ length: rows }, () => Array<boolean>(cols).fill(false))

  for (const obs of obstacles ?? []) {
    const x0 = Math.max(0, Math.floor(obs.x / cell))
    const y0 = Math.max(0, Math.floor(obs.y / cell))
    const x1 = Math.min(cols, Math.ceil((obs.x + obs.w) / cell))
    const y1 = Math.min(rows, Math.ceil((obs.y + obs.h) / cell))
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        blocked[y]![x] = true
      }
    }
  }

  return blocked
}

function pickFreeCell(
  blocked: boolean[][],
  cols: number,
  rows: number,
  avoid: { x: number; y: number }[],
) {
  for (let n = 0; n < 40; n++) {
    const x = 1 + Math.floor(Math.random() * (cols - 2))
    const y = 1 + Math.floor(Math.random() * (rows - 2))
    if (blocked[y]![x]) continue
    if (avoid.some((s) => s.x === x && s.y === y)) continue
    return { x, y }
  }
  return { x: Math.floor(cols / 2), y: Math.floor(rows / 2) }
}

/** Классическая змейка на весь экран, обходит UI-якоря */
function createSnake(local: PlayRegion): Scene {
  const cell = 12
  const scale = 2
  const cols = Math.floor(local.w / cell)
  const rows = Math.floor(local.h / cell)
  const blocked = buildObstacleGrid(local.obstacles, cell, cols, rows)

  const dirs = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 },
  ]

  function wrap(value: number, max: number) {
    if (value < 0) return max - 1
    if (value >= max) return 0
    return value
  }

  let dir = dirs[0]!
  let head = pickFreeCell(blocked, cols, rows, [])
  const body: { x: number; y: number }[] = Array.from({ length: 14 }, (_, i) => ({
    x: wrap(head.x - (i + 1), cols),
    y: head.y,
  }))
  let food = pickFreeCell(blocked, cols, rows, [head, ...body])
  let moveCd = 0

  function isBlocked(x: number, y: number) {
    const wx = wrap(x, cols)
    const wy = wrap(y, rows)
    if (blocked[wy]![wx]) return true
    return body.some((s) => s.x === wx && s.y === wy)
  }

  function pickDir() {
    const options = dirs.filter((d) => {
      if (d.x === -dir.x && d.y === -dir.y) return false
      return !isBlocked(head.x + d.x, head.y + d.y)
    })
    if (options.length === 0) return
    if (Math.random() < 0.12) {
      dir = options[Math.floor(Math.random() * options.length)]!
    }
  }

  return {
    anchorId: local.anchorId,
    tick(dt) {
      moveCd -= dt
      if (moveCd > 0) return
      moveCd = 95

      pickDir()

      const next = {
        x: wrap(head.x + dir.x, cols),
        y: wrap(head.y + dir.y, rows),
      }

      if (blocked[next.y]![next.x]) {
        const alt = dirs.find(
          (d) =>
            !(d.x === -dir.x && d.y === -dir.y) &&
            !isBlocked(head.x + d.x, head.y + d.y),
        )
        if (!alt) return
        dir = alt
        head = {
          x: wrap(head.x + dir.x, cols),
          y: wrap(head.y + dir.y, rows),
        }
      } else {
        head = next
      }

      body.unshift({ ...head })
      if (head.x === food.x && head.y === food.y) {
        food = pickFreeCell(blocked, cols, rows, [head, ...body])
      } else {
        body.pop()
      }
    },
    draw(ctx) {
      ctx.fillStyle = 'rgba(255, 90, 90, 0.8)'
      ctx.fillRect(food.x * cell + 2, food.y * cell + 2, cell - 4, cell - 4)

      for (let i = body.length - 1; i >= 0; i--) {
        const seg = body[i]!
        drawSpriteTinted(
          ctx,
          SNAKE_BODY,
          seg.x * cell + 1,
          seg.y * cell + 1,
          scale,
          'rgba(90, 200, 90, 0.5)',
        )
      }

      drawSpriteTinted(
        ctx,
        SNAKE_HEAD,
        head.x * cell + 1,
        head.y * cell + 1,
        scale,
        'rgba(130, 255, 130, 0.88)',
        'rgba(20, 80, 20, 0.35)',
      )
    },
  }
}

/** Tetris well stacked above the download CTA */
function createFallingBlock(local: PlayRegion, anchor?: AnchorRect): Scene {
  const cell = 12
  const cols = Math.floor(local.w / cell)
  const rows = Math.floor(local.h / cell)
  const pieces = [TETRIS_L, TETRIS_T, TETRIS_I] as const
  let piece = TETRIS_L
  let x = Math.floor(cols / 2) - 1
  let y = -2
  let rot = 0
  let fallCd = 0
  const stack: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0))

  function shape() {
    if (rot % 2 === 0) return piece
    const h = piece.length
    const w = piece[0]!.length
    return Array.from({ length: w }, (_, c) =>
      Array.from({ length: h }, (_, r) => piece[h - 1 - r]![c]!),
    )
  }

  function lock() {
    const grid = shape()
    for (let r = 0; r < grid.length; r++) {
      for (let c = 0; c < grid[r]!.length; c++) {
        if (!grid[r]![c]) continue
        const gy = y + r
        const gx = x + c
        if (gy >= 0 && gy < rows && gx >= 0 && gx < cols) stack[gy]![gx] = 1
      }
    }
    piece = pieces[Math.floor(Math.random() * pieces.length)]!
    x = Math.floor(cols / 2) - 1
    y = -2
    rot += 1
  }

  return {
    anchorId: local.anchorId,
    tick(dt) {
      fallCd -= dt
      if (fallCd > 0) return
      fallCd = 380
      y += 1
      const grid = shape()
      let landed = false
      for (let r = 0; r < grid.length; r++) {
        for (let c = 0; c < grid[r]!.length; c++) {
          if (!grid[r]![c]) continue
          const gy = y + r + 1
          const gx = x + c
          if (gy >= rows || (gy >= 0 && stack[gy]![gx])) landed = true
        }
      }
      if (landed) {
        y -= 1
        lock()
      }
    },
    draw(ctx) {
      ctx.fillStyle = 'rgba(255,255,255,0.04)'
      ctx.fillRect(0, 0, local.w, local.h)

      for (let gy = 0; gy < rows; gy++) {
        for (let gx = 0; gx < cols; gx++) {
          ctx.strokeStyle = 'rgba(255,255,255,0.06)'
          ctx.strokeRect(gx * cell + 0.5, gy * cell + 0.5, cell, cell)
          if (stack[gy]![gx]) {
            drawBlock(
              ctx,
              gx * cell + 1,
              gy * cell + 1,
              cell,
              'rgba(150, 100, 255, 0.55)',
              'rgba(210, 180, 255, 0.35)',
            )
          }
        }
      }

      const grid = shape()
      const colors = ['rgba(180, 120, 255, 0.72)', 'rgba(210, 180, 255, 0.4)']
      for (let r = 0; r < grid.length; r++) {
        for (let c = 0; c < grid[r]!.length; c++) {
          if (!grid[r]![c]) continue
          drawBlock(
            ctx,
            (x + c) * cell + 1,
            (y + r) * cell + 1,
            cell,
            colors[0]!,
            colors[1]!,
          )
        }
      }

      if (anchor) {
        ctx.fillStyle = 'rgba(255,255,255,0.1)'
        ctx.fillRect(local.w / 2 - 1, local.h - 6, 2, 6)
      }
    },
  }
}

/** Invader formation descends toward the logo */
function createAliens(local: PlayRegion, anchor?: AnchorRect): Scene {
  const sprites = [INVADER_A, INVADER_B]
  const cols = 8
  const rows = 3
  const aliens: { x: number; y: number; row: number; alive: boolean }[] = []

  const gridW = cols * 22
  const startX = (local.w - gridW) / 2

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      aliens.push({
        x: startX + c * 22,
        y: 14 + r * 20,
        row: r,
        alive: true,
      })
    }
  }

  let dir = 1
  let stepCd = 0
  let frame = 0
  let bullet: { x: number; y: number } | null = null
  const cannonX = local.w / 2 - (CANNON_SPRITE[0]!.length * PX) / 2
  const targetY = anchor ? local.h - 8 : local.h - 14

  return {
    anchorId: local.anchorId,
    tick(dt) {
      stepCd -= dt
      frame += dt

      if (stepCd <= 0) {
        stepCd = 480
        for (const a of aliens) {
          if (!a.alive) continue
          a.x += dir * 5
        }

        const hitEdge = aliens.some(
          (a) => a.alive && (a.x < 4 || a.x > local.w - 20),
        )
        if (hitEdge) {
          dir *= -1
          for (const a of aliens) if (a.alive) a.y += 6
        }

        if (!bullet && Math.random() < 0.35) {
          const live = aliens.filter((a) => a.alive)
          const shooter = live[Math.floor(Math.random() * live.length)]
          if (shooter) {
            bullet = { x: shooter.x + 5, y: shooter.y + 10 }
          }
        }
      }

      if (bullet) {
        bullet.y += 0.2 * dt
        if (bullet.y > targetY + 20) bullet = null
      }
    },
    draw(ctx) {
      const spriteIdx = Math.floor(frame / 500) % 2

      for (const a of aliens) {
        if (!a.alive) continue
        const sprite = sprites[(a.row + spriteIdx) % sprites.length]!
        drawSpriteTinted(
          ctx,
          sprite,
          a.x,
          a.y,
          PX,
          'rgba(140, 255, 175, 0.72)',
          'rgba(20, 80, 40, 0.35)',
        )
      }

      if (bullet) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
        ctx.fillRect(bullet.x, bullet.y, 2, 7)
      }

      drawSpriteTinted(
        ctx,
        CANNON_SPRITE,
        cannonX,
        targetY,
        PX,
        'rgba(170, 200, 255, 0.65)',
      )

      if (anchor) {
        ctx.strokeStyle = 'rgba(140, 255, 175, 0.12)'
        ctx.beginPath()
        ctx.moveTo(local.w / 2, local.h - 4)
        ctx.lineTo(local.w / 2, local.h)
        ctx.stroke()
      }
    },
  }
}

/** Vertical pong court beside the hero block */
function createPaddleBall(local: PlayRegion): Scene {
  const paddleH = Math.min(44, local.h * 0.22)
  const ballR = 4
  let ball = { x: local.w / 2, y: local.h / 2, vy: 0.16 }
  let leftY = local.h / 2 - paddleH / 2
  let rightY = local.h / 2 - paddleH / 2
  let dir = 1
  let speed = 0.14

  return {
    anchorId: local.anchorId,
    tick(dt) {
      ball.y += ball.vy * dt

      if (ball.y < ballR + 4) {
        ball.y = ballR + 4
        ball.vy *= -1
      }
      if (ball.y > local.h - ballR - 4) {
        ball.y = local.h - ballR - 4
        ball.vy *= -1
      }

      leftY += (ball.y - leftY - paddleH / 2) * 0.035
      rightY += (ball.y - rightY - paddleH / 2) * 0.03

      ball.x += dir * speed * dt

      if (ball.x < 10 + ballR && dir < 0) {
        if (ball.y > leftY && ball.y < leftY + paddleH) {
          dir = 1
          speed = Math.min(0.22, speed + 0.01)
        }
      }
      if (ball.x > local.w - 10 - ballR && dir > 0) {
        if (ball.y > rightY && ball.y < rightY + paddleH) {
          dir = -1
          speed = Math.min(0.22, speed + 0.01)
        }
      }

      if (ball.x < 0 || ball.x > local.w) {
        ball = { x: local.w / 2, y: local.h / 2, vy: 0.16 * (Math.random() > 0.5 ? 1 : -1) }
        dir = Math.random() > 0.5 ? 1 : -1
        speed = 0.14
      }
    },
    draw(ctx) {
      ctx.fillStyle = 'rgba(255,255,255,0.04)'
      ctx.fillRect(0, 0, local.w, local.h)

      ctx.strokeStyle = 'rgba(255,255,255,0.1)'
      ctx.setLineDash([3, 6])
      ctx.beginPath()
      ctx.moveTo(local.w / 2, 6)
      ctx.lineTo(local.w / 2, local.h - 6)
      ctx.stroke()
      ctx.setLineDash([])

      ctx.fillStyle = 'rgba(255,255,255,0.55)'
      ctx.fillRect(6, leftY, 3, paddleH)
      ctx.fillRect(local.w - 9, rightY, 3, paddleH)

      ctx.beginPath()
      ctx.arc(ball.x, ball.y, ballR, 0, Math.PI * 2)
      ctx.fill()
    },
  }
}

/** Pac-Man eats dots along the platform-picker row */
function createChomper(local: PlayRegion): Scene {
  const dotCount = Math.max(8, Math.floor(local.w / 22))
  const dots = Array.from({ length: dotCount }, (_, i) => ({
    x: 12 + i * ((local.w - 24) / (dotCount - 1)),
    eaten: false,
  }))
  let pacX = 8
  let mouth = 0
  let ghostX = -24
  const laneY = local.h / 2

  return {
    anchorId: local.anchorId,
    tick(dt) {
      pacX += 0.11 * dt
      mouth += dt * 0.018
      ghostX += 0.095 * dt

      for (const dot of dots) {
        if (!dot.eaten && Math.abs(pacX - dot.x) < 9) dot.eaten = true
      }

      if (pacX > local.w + 24) {
        pacX = 8
        ghostX = -24
        for (const dot of dots) dot.eaten = false
      }
    },
    draw(ctx) {
      ctx.strokeStyle = 'rgba(255, 220, 60, 0.12)'
      ctx.setLineDash([4, 8])
      ctx.beginPath()
      ctx.moveTo(0, laneY)
      ctx.lineTo(local.w, laneY)
      ctx.stroke()
      ctx.setLineDash([])

      ctx.fillStyle = 'rgba(255, 255, 255, 0.45)'
      for (const dot of dots) {
        if (dot.eaten) continue
        ctx.beginPath()
        ctx.arc(dot.x, laneY, 2.5, 0, Math.PI * 2)
        ctx.fill()
      }

      drawPacMan(ctx, pacX, laneY, 11, mouth, true)

      drawSpriteTinted(
        ctx,
        GHOST_SPRITE,
        ghostX - 8,
        laneY - 8,
        1,
        'rgba(255, 70, 70, 0.72)',
        'rgba(80, 0, 0, 0.3)',
      )
    },
  }
}
