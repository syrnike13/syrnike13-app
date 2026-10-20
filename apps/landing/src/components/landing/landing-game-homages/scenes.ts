import {
  drawSpriteTinted,
  ENEMY_SPRITE,
  SHIP_SPRITE,
  SNAKE_BODY,
  SNAKE_HEAD,
} from './sprites'
import type { HomageKind, PlayRegion, Scene } from './types'

const PX = 2

function withRegion(region: PlayRegion, factory: (local: PlayRegion) => Scene): Scene {
  const scene = factory(region)
  return {
    anchorId: region.anchorId,
    tick: scene.tick,
    draw(ctx) {
      ctx.save()
      ctx.translate(region.x, region.y)
      scene.draw(ctx)
      ctx.restore()
    },
  }
}

export function createScene(kind: HomageKind, region: PlayRegion): Scene {
  switch (kind) {
    case 'sideShooter':
      return withRegion(region, createSideShooter)
    case 'snake':
      return withRegion(region, createSnake)
    case 'paddleBall':
      return withRegion(region, createPaddleBall)
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
  for (let n = 0; n < 60; n++) {
    const x = 1 + Math.floor(Math.random() * (cols - 2))
    const y = 1 + Math.floor(Math.random() * (rows - 2))
    if (blocked[y]![x]) continue
    if (avoid.some((s) => s.x === x && s.y === y)) continue
    return { x, y }
  }
  return { x: Math.floor(cols / 2), y: Math.floor(rows / 2) }
}

function createSideShooter(local: PlayRegion): Scene {
  const stars = Array.from({ length: 80 }, () => ({
    x: Math.random() * local.w,
    y: Math.random() * local.h,
    s: 0.4 + Math.random() * 1.4,
  }))
  const bullets: { x: number; y: number }[] = []
  const enemies: { x: number; y: number; hp: number }[] = []
  let shipY = local.h / 2
  let t = 0
  let shootCd = 0
  let spawnCd = 300

  return {
    anchorId: local.anchorId,
    tick(dt) {
      t += dt
      shipY = local.h / 2 + Math.sin(t * 0.002) * (local.h * 0.38)
      shootCd -= dt
      spawnCd -= dt

      for (const star of stars) {
        star.x -= star.s * 0.1 * dt
        if (star.x < -2) {
          star.x = local.w + 2
          star.y = Math.random() * local.h
        }
      }

      if (shootCd <= 0) {
        bullets.push({ x: 36, y: shipY + 6 })
        shootCd = 200
      }

      if (spawnCd <= 0) {
        enemies.push({
          x: local.w + 24,
          y: 16 + Math.random() * (local.h - 32),
          hp: 1,
        })
        spawnCd = 550 + Math.random() * 450
      }

      for (const b of bullets) b.x += 0.45 * dt
      for (const e of enemies) e.x -= 0.16 * dt

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

      bullets.splice(0, bullets.length, ...bullets.filter((b) => b.x < local.w + 24))
      enemies.splice(0, enemies.length, ...enemies.filter((e) => e.hp > 0 && e.x > -40))
    },
    draw(ctx) {
      ctx.fillStyle = 'rgba(255,255,255,0.1)'
      for (const star of stars) ctx.fillRect(star.x, star.y, 1, 1)

      drawSpriteTinted(
        ctx,
        SHIP_SPRITE,
        20,
        shipY,
        PX,
        'rgba(170, 210, 255, 0.75)',
        'rgba(40, 70, 140, 0.25)',
      )

      ctx.fillStyle = 'rgba(255, 220, 90, 0.85)'
      for (const b of bullets) ctx.fillRect(b.x, b.y, 12, 2)

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
    },
  }
}

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
  const body: { x: number; y: number }[] = Array.from({ length: 16 }, (_, i) => ({
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
    if (Math.random() < 0.14) {
      dir = options[Math.floor(Math.random() * options.length)]!
    }
  }

  return {
    anchorId: local.anchorId,
    tick(dt) {
      moveCd -= dt
      if (moveCd > 0) return
      moveCd = 90

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

function createPaddleBall(local: PlayRegion): Scene {
  const paddleH = Math.max(56, local.h * 0.14)
  const ballR = 5
  let ball = { x: local.w / 2, y: local.h / 2, vy: 0.18 }
  let leftY = local.h / 2 - paddleH / 2
  let rightY = local.h / 2 - paddleH / 2
  let dir = 1
  let speed = 0.16

  return {
    anchorId: local.anchorId,
    tick(dt) {
      ball.y += ball.vy * dt

      if (ball.y < ballR + 8) {
        ball.y = ballR + 8
        ball.vy *= -1
      }
      if (ball.y > local.h - ballR - 8) {
        ball.y = local.h - ballR - 8
        ball.vy *= -1
      }

      leftY += (ball.y - leftY - paddleH / 2) * 0.04
      rightY += (ball.y - rightY - paddleH / 2) * 0.035

      ball.x += dir * speed * dt

      if (ball.x < 14 + ballR && dir < 0) {
        if (ball.y > leftY && ball.y < leftY + paddleH) {
          dir = 1
          speed = Math.min(0.26, speed + 0.012)
        }
      }
      if (ball.x > local.w - 14 - ballR && dir > 0) {
        if (ball.y > rightY && ball.y < rightY + paddleH) {
          dir = -1
          speed = Math.min(0.26, speed + 0.012)
        }
      }

      if (ball.x < 0 || ball.x > local.w) {
        ball = { x: local.w / 2, y: local.h / 2, vy: 0.18 * (Math.random() > 0.5 ? 1 : -1) }
        dir = Math.random() > 0.5 ? 1 : -1
        speed = 0.16
      }
    },
    draw(ctx) {
      ctx.fillStyle = 'rgba(255,255,255,0.55)'
      ctx.fillRect(10, leftY, 4, paddleH)
      ctx.fillRect(local.w - 14, rightY, 4, paddleH)

      ctx.beginPath()
      ctx.arc(ball.x, ball.y, ballR, 0, Math.PI * 2)
      ctx.fill()
    },
  }
}
