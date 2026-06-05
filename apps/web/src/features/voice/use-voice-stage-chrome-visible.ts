import { useCallback, useEffect, useRef, useState } from 'react'

import { cn } from '#/lib/utils'

const CHROME_IDLE_MS = 2_500

const chromeMotionTransition =
  'transition-[transform,opacity] duration-300 ease-out' as const

export function voiceStageChromeMotion(
  visible: boolean,
  edge: 'top' | 'bottom',
) {
  if (visible) {
    return cn(
      chromeMotionTransition,
      'translate-y-0 opacity-100 pointer-events-auto',
    )
  }

  return cn(
    chromeMotionTransition,
    'opacity-0 pointer-events-none',
    edge === 'top' ? '-translate-y-full' : 'translate-y-full',
  )
}

export function useVoiceStageChromeVisible() {
  const stageRef = useRef<HTMLDivElement>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointerRef = useRef({ x: 0, y: 0 })
  const [chromeVisible, setChromeVisible] = useState(true)

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }, [])

  const isPointerOverChrome = useCallback(() => {
    const { x, y } = pointerRef.current
    const target = document.elementFromPoint(x, y)
    if (!target) return false

    return Boolean(
      target.closest('[data-voice-stage-chrome]') ??
        target.closest('[data-voice-stage-popover]'),
    )
  }, [])

  const scheduleHide = useCallback(() => {
    clearHideTimer()
    hideTimerRef.current = setTimeout(() => {
      if (isPointerOverChrome()) {
        scheduleHide()
        return
      }
      setChromeVisible(false)
    }, CHROME_IDLE_MS)
  }, [clearHideTimer, isPointerOverChrome])

  const revealChrome = useCallback(() => {
    setChromeVisible(true)
    scheduleHide()
  }, [scheduleHide])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return

    const onPointerActivity = (event: PointerEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY }
      revealChrome()
    }

    const onFocusIn = () => {
      revealChrome()
    }

    stage.addEventListener('pointermove', onPointerActivity)
    stage.addEventListener('pointerdown', onPointerActivity)
    stage.addEventListener('pointerenter', onPointerActivity)
    stage.addEventListener('focusin', onFocusIn)

    revealChrome()

    return () => {
      stage.removeEventListener('pointermove', onPointerActivity)
      stage.removeEventListener('pointerdown', onPointerActivity)
      stage.removeEventListener('pointerenter', onPointerActivity)
      stage.removeEventListener('focusin', onFocusIn)
      clearHideTimer()
    }
  }, [clearHideTimer, revealChrome])

  return { stageRef, chromeVisible, revealChrome }
}
