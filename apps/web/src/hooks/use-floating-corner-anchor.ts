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
  offsetX: number
  offsetY: number
}

export function useFloatingCornerAnchor(
  storageKey: string,
  fallback: FloatingCorner = 'top-right',
  preservePointerOffset = false,
) {
  const [corner, setCorner] = useState(() =>
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

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || !event.isPrimary) return
      suppressClickRef.current = false
      event.currentTarget.setPointerCapture(event.pointerId)
      const rect = event.currentTarget.getBoundingClientRect()
      dragStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        offsetX: preservePointerOffset
          ? rect.left + rect.width / 2 - event.clientX
          : 0,
        offsetY: preservePointerOffset
          ? rect.top + rect.height / 2 - event.clientY
          : 0,
      }
    },
    [preservePointerOffset],
  )

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const state = dragStateRef.current
    if (!state || state.pointerId !== event.pointerId) return

    const dx = event.clientX - state.startX
    const dy = event.clientY - state.startY
    if (!state.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return

    state.moved = true
    setDragPoint({
      x: event.clientX + state.offsetX,
      y: event.clientY + state.offsetY,
    })
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
            event.clientX + state.offsetX,
            event.clientY + state.offsetY,
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
      suppressClickRef.current = state.moved
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
