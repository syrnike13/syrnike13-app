import { useEffect, useRef, useState } from 'react'

import { cn } from '#/lib/utils'

import { buildPlayRegion, collectAnchors } from './anchors'
import { createScene } from './scenes'
import type { HomageAnchorId, HomageKind } from './types'

export type { HomageKind } from './types'

const HOMAGES: HomageKind[] = ['sideShooter', 'snake', 'paddleBall']

const HOMAGE_DEBUG_LABELS: Record<HomageKind, string> = {
  sideShooter: 'Gradius',
  snake: 'Snake',
  paddleBall: 'Pong',
}

const PLAY_MS = 7_000
const GAP_MIN_MS = 22_000
const GAP_MAX_MS = 48_000

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min)
}

function pickHomage(last: HomageKind | null) {
  const pool = last ? HOMAGES.filter((h) => h !== last) : HOMAGES
  return pool[Math.floor(Math.random() * pool.length)]!
}

function setActiveAnchor(id: HomageAnchorId | null) {
  document.querySelectorAll('[data-homage-anchor]').forEach((el) => {
    el.classList.toggle(
      'homage-active',
      el.getAttribute('data-homage-anchor') === id,
    )
  })
}

export function LandingGameHomages() {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef(0)
  const timeoutRef = useRef(0)
  const playRef = useRef<(kind?: HomageKind) => void>(() => {})
  const [debugEnabled] = useState(() => import.meta.env.DEV)

  useEffect(() => {
    if (!wrapRef.current || !canvasRef.current) return

    const wrapEl = wrapRef.current
    const canvasEl = canvasRef.current
    const rawCtx = canvasEl.getContext('2d')
    if (!rawCtx) return
    const drawCtx: CanvasRenderingContext2D = rawCtx

    let viewW = 0
    let viewH = 0
    let lastKind: HomageKind | null = null
    let scene: ReturnType<typeof createScene> | null = null
    let playing = false
    let playStart = 0
    let lastFrame = 0
    let opacity = 0

    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    function resizeCanvas() {
      const rect = wrapEl.getBoundingClientRect()
      viewW = rect.width
      viewH = rect.height
      canvasEl.width = Math.floor(viewW * dpr)
      canvasEl.height = Math.floor(viewH * dpr)
      canvasEl.style.width = `${viewW}px`
      canvasEl.style.height = `${viewH}px`
      drawCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
      drawCtx.imageSmoothingEnabled = false
    }

    function startHomage(forcedKind?: HomageKind) {
      clearTimeout(timeoutRef.current)
      resizeCanvas()

      const kind = forcedKind ?? pickHomage(lastKind)
      const anchors = collectAnchors(wrapEl)
      const region = buildPlayRegion(kind, anchors, viewW, viewH)

      if (!region) {
        scheduleNext(3000)
        return
      }

      lastKind = kind
      scene = createScene(kind, region)
      playing = true
      playStart = performance.now()
      lastFrame = playStart
      opacity = 0
      canvasEl.style.opacity = '0'
      setActiveAnchor(region.suppressHighlight ? null : region.anchorId)
    }

    function scheduleNext(delay = randomBetween(GAP_MIN_MS, GAP_MAX_MS)) {
      setActiveAnchor(null)
      timeoutRef.current = window.setTimeout(() => {
        startHomage()
      }, delay)
    }

    playRef.current = (kind) => startHomage(kind)

    function frame(now: number) {
      rafRef.current = requestAnimationFrame(frame)

      if (!playing || !scene) return

      const elapsed = now - playStart
      const dt = Math.min(now - lastFrame, 50)
      lastFrame = now

      if (elapsed < 600) opacity = elapsed / 600
      else if (elapsed > PLAY_MS - 800) opacity = Math.max(0, (PLAY_MS - elapsed) / 800)
      else opacity = 1

      canvasEl.style.opacity = String(opacity * 0.3)

      if (elapsed >= PLAY_MS) {
        playing = false
        scene = null
        setActiveAnchor(null)
        drawCtx.clearRect(0, 0, viewW, viewH)
        scheduleNext()
        return
      }

      scene.tick(dt)
      drawCtx.clearRect(0, 0, viewW, viewH)
      scene.draw(drawCtx)
    }

    resizeCanvas()

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!reduced) {
      const initialDelay = randomBetween(4_000, 10_000)
      timeoutRef.current = window.setTimeout(() => startHomage(), initialDelay)
    }

    rafRef.current = requestAnimationFrame(frame)

    const onResize = () => {
      resizeCanvas()
      if (playing) {
        const kind = lastKind
        if (kind) startHomage(kind)
      }
    }
    window.addEventListener('resize', onResize)

    return () => {
      cancelAnimationFrame(rafRef.current)
      clearTimeout(timeoutRef.current)
      setActiveAnchor(null)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  return (
    <>
      <div
        ref={wrapRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[1] overflow-hidden"
      >
        <canvas ref={canvasRef} className="absolute inset-0" />
      </div>

      {debugEnabled && (
        <div className="pointer-events-auto fixed bottom-4 left-4 z-50 max-w-[min(100vw-2rem,22rem)] rounded-lg border border-border/60 bg-card/95 p-2 shadow-lg backdrop-blur-sm">
          <p className="mb-1.5 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Фоновые отсылки (dev)
          </p>
          <div className="flex flex-wrap gap-1">
            {HOMAGES.map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => playRef.current(kind)}
                className={cn(
                  'rounded-md border border-border/50 px-2 py-1 text-[11px]',
                  'text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                )}
              >
                {HOMAGE_DEBUG_LABELS[kind]}
              </button>
            ))}
            <button
              type="button"
              onClick={() => playRef.current()}
              className={cn(
                'rounded-md border border-dashed border-border/50 px-2 py-1 text-[11px]',
                'text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
              )}
            >
              Случайная
            </button>
          </div>
        </div>
      )}
    </>
  )
}
