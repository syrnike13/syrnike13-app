import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

import {
  floatingCornerFromStorage,
  nearestFloatingCorner,
  saveFloatingCorner,
  type FloatingCorner,
} from '#/lib/floating-corner'

const DRAG_THRESHOLD_PX = 8

type DragState = {
  pointerId: number
  startX: number
  startY: number
  moved: boolean
}

export function useFloatingCornerAnchor(
  storageKey: string,
  fallback: FloatingCorner = 'top-right',
) {
  const [corner, setCorner] = useState<FloatingCorner>(() =>
    floatingCornerFromStorage(storageKey, fallback),
  )
  const [dragPoint, setDragPoint] = useState<{ x: number; y: number } | null>(
    null,
  )
  const dragStateRef = useRef<DragState | null>(null)
  const suppressClickRef = useRef(false)

  const persistCorner = useCallback(
    (next: FloatingCorner) => {
      setCorner(next)
      saveFloatingCorner(storageKey, next)
    },
    [storageKey],
  )

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    }
  }, [])

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const state = dragStateRef.current
    if (!state || state.pointerId !== event.pointerId) return

    const dx = event.clientX - state.startX
    const dy = event.clientY - state.startY
    if (!state.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return

    state.moved = true
    setDragPoint({ x: event.clientX, y: event.clientY })
  }, [])

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const state = dragStateRef.current
      if (!state || state.pointerId !== event.pointerId) return

      dragStateRef.current = null
      if (state.moved) {
        suppressClickRef.current = true
        persistCorner(
          nearestFloatingCorner(
            event.clientX,
            event.clientY,
            window.innerWidth,
            window.innerHeight,
          ),
        )
        setDragPoint(null)
      }
    },
    [persistCorner],
  )

  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const state = dragStateRef.current
      if (!state || state.pointerId !== event.pointerId) return
      dragStateRef.current = null
      setDragPoint(null)
    },
    [],
  )

  const consumeSuppressedClick = useCallback(() => {
    if (!suppressClickRef.current) return false
    suppressClickRef.current = false
    return true
  }, [])

  return {
    corner,
    dragPoint,
    isDragging: dragPoint != null,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    consumeSuppressedClick,
  }
}
