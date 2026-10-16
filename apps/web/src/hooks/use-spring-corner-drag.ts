import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import {
  floatingCornerFromStorage,
  nearestFloatingCorner,
  saveFloatingCorner,
  type FloatingCorner,
} from '#/lib/floating-corner'

type Point = { x: number; y: number }
type Spring = { stiffness: number; damping: number }

const DRAG_THRESHOLD_PX = 6
/** Пока карточку держат: быстрое, почти критически задемпфированное следование. */
const DRAG_SPRING: Spring = { stiffness: 1100, damping: 66 }
/** После отпускания: мягче и чуть недодемпфировано — лёгкий «прилип» к углу. */
const SETTLE_SPRING: Spring = { stiffness: 380, damping: 30 }
const SIM_STEP_S = 1 / 240
const MAX_FRAME_S = 1 / 20
/** Насколько далеко «пролетает» карточка по инерции при броске. */
const THROW_PROJECTION_S = 0.16
const MAX_THROW_VELOCITY = 3200
const VELOCITY_WINDOW_MS = 90

type DragState = {
  pointerId: number
  startX: number
  startY: number
  offsetX: number
  offsetY: number
  moved: boolean
  samples: { x: number; y: number; t: number }[]
}

function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

function capVelocity(value: number) {
  return Math.max(-MAX_THROW_VELOCITY, Math.min(MAX_THROW_VELOCITY, value))
}

function pointerVelocity(samples: DragState['samples']): Point {
  if (samples.length < 2) return { x: 0, y: 0 }
  const last = samples[samples.length - 1]
  const first =
    samples.find((sample) => last.t - sample.t <= VELOCITY_WINDOW_MS) ?? last
  const dt = (last.t - first.t) / 1000
  if (dt < 0.004) return { x: 0, y: 0 }
  return {
    x: capVelocity((last.x - first.x) / dt),
    y: capVelocity((last.y - first.y) / dt),
  }
}

/**
 * Плавающая карточка, которую можно таскать и бросать в угол окна.
 * Позиция анимируется пружиной через `transform` напрямую в DOM, без
 * ре-рендеров React на каждый кадр/движение указателя.
 */
export function useSpringCornerDrag({
  storageKey,
  fallback,
  cornerPosition,
  clamp,
  size,
}: {
  storageKey: string
  fallback: FloatingCorner
  /** Левый верхний угол карточки в состоянии покоя для данного угла окна. */
  cornerPosition: (corner: FloatingCorner) => Point
  clamp: (point: Point) => Point
  size: { width: number; height: number }
}) {
  const [corner, setCorner] = useState(() =>
    floatingCornerFromStorage(storageKey, fallback),
  )
  const [dragging, setDragging] = useState(false)
  const rest = cornerPosition(corner)

  const latest = useRef({ cornerPosition, clamp, size })
  latest.current = { cornerPosition, clamp, size }

  const elementRef = useRef<HTMLElement | null>(null)
  const pos = useRef<Point>(rest)
  const vel = useRef<Point>({ x: 0, y: 0 })
  const target = useRef<Point>(rest)
  const mode = useRef<'idle' | 'drag' | 'settle'>('idle')
  const frame = useRef(0)
  const lastFrameAt = useRef(0)
  const drag = useRef<DragState | null>(null)
  const suppressClick = useRef(false)

  const apply = useCallback(() => {
    const element = elementRef.current
    if (!element) return
    element.style.transform = `translate3d(${pos.current.x}px, ${pos.current.y}px, 0)`
  }, [])

  const ref = useCallback(
    (element: HTMLElement | null) => {
      elementRef.current = element
      if (element) apply()
    },
    [apply],
  )

  const step = useCallback(
    (now: number) => {
      const elapsed = Math.min(
        MAX_FRAME_S,
        Math.max(0, (now - lastFrameAt.current) / 1000),
      )
      lastFrameAt.current = now
      const spring = mode.current === 'drag' ? DRAG_SPRING : SETTLE_SPRING
      let remaining = elapsed
      while (remaining > 0) {
        const h = Math.min(SIM_STEP_S, remaining)
        remaining -= h
        for (const axis of ['x', 'y'] as const) {
          const accel =
            -spring.stiffness * (pos.current[axis] - target.current[axis]) -
            spring.damping * vel.current[axis]
          vel.current[axis] += accel * h
          pos.current[axis] += vel.current[axis] * h
        }
      }
      const settled =
        Math.abs(pos.current.x - target.current.x) < 0.25 &&
        Math.abs(pos.current.y - target.current.y) < 0.25 &&
        Math.abs(vel.current.x) < 8 &&
        Math.abs(vel.current.y) < 8
      if (settled && mode.current !== 'drag') {
        pos.current = { ...target.current }
        vel.current = { x: 0, y: 0 }
        mode.current = 'idle'
        frame.current = 0
        apply()
        return
      }
      apply()
      frame.current = requestAnimationFrame(step)
    },
    [apply],
  )

  const animate = useCallback(() => {
    if (prefersReducedMotion()) {
      pos.current = { ...target.current }
      vel.current = { x: 0, y: 0 }
      if (mode.current === 'settle') mode.current = 'idle'
      apply()
      return
    }
    if (frame.current) return
    lastFrameAt.current = performance.now()
    frame.current = requestAnimationFrame(step)
  }, [apply, step])

  useEffect(
    () => () => {
      if (frame.current) cancelAnimationFrame(frame.current)
      frame.current = 0
    },
    [],
  )

  // Угол/размер/окно поменялись: в покое — мгновенно, при «прилипании» — догоняем.
  useLayoutEffect(() => {
    if (mode.current === 'drag') return
    target.current = { x: rest.x, y: rest.y }
    if (mode.current === 'settle') {
      animate()
      return
    }
    pos.current = { x: rest.x, y: rest.y }
    vel.current = { x: 0, y: 0 }
    apply()
  }, [rest.x, rest.y, animate, apply])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !event.isPrimary) return
    suppressClick.current = false
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - pos.current.x,
      offsetY: event.clientY - pos.current.y,
      moved: false,
      samples: [{ x: event.clientX, y: event.clientY, t: performance.now() }],
    }
  }, [])

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const state = drag.current
      if (!state || state.pointerId !== event.pointerId) return
      if (
        !state.moved &&
        Math.hypot(event.clientX - state.startX, event.clientY - state.startY) <
          DRAG_THRESHOLD_PX
      )
        return
      if (!state.moved) {
        state.moved = true
        mode.current = 'drag'
        setDragging(true)
      }
      const now = performance.now()
      state.samples.push({ x: event.clientX, y: event.clientY, t: now })
      while (
        state.samples.length > 2 &&
        now - state.samples[0].t > VELOCITY_WINDOW_MS * 2
      )
        state.samples.shift()
      target.current = latest.current.clamp({
        x: event.clientX - state.offsetX,
        y: event.clientY - state.offsetY,
      })
      animate()
    },
    [animate],
  )

  const finish = useCallback(
    (event: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
      const state = drag.current
      if (!state || state.pointerId !== event.pointerId) return
      drag.current = null
      if (!state.moved) return
      suppressClick.current = true
      setDragging(false)
      const { width, height } = latest.current.size
      const velocity = cancelled
        ? { x: 0, y: 0 }
        : pointerVelocity(state.samples)
      const projected = latest.current.clamp({
        x: target.current.x + velocity.x * THROW_PROJECTION_S,
        y: target.current.y + velocity.y * THROW_PROJECTION_S,
      })
      const next = cancelled
        ? corner
        : nearestFloatingCorner(
            projected.x + width / 2,
            projected.y + height / 2,
            window.innerWidth,
            window.innerHeight,
          )
      mode.current = 'settle'
      vel.current = { x: velocity.x, y: velocity.y }
      target.current = latest.current.cornerPosition(next)
      if (next !== corner) {
        setCorner(next)
        saveFloatingCorner(storageKey, next)
      }
      animate()
    },
    [animate, corner, storageKey],
  )

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => finish(event, false),
    [finish],
  )
  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => finish(event, true),
    [finish],
  )

  const consumeSuppressedClick = useCallback(() => {
    if (!suppressClick.current) return false
    suppressClick.current = false
    return true
  }, [])

  return {
    ref,
    corner,
    dragging,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    consumeSuppressedClick,
  }
}
