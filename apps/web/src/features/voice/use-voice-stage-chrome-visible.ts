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

export function useVoiceStageChromeVisible(attachKey: string | boolean = true) {
  const [stageElement, setStageElement] = useState<HTMLDivElement | null>(null)
  const stageRef = useCallback((node: HTMLDivElement | null) => {
    setStageElement(node)
  }, [])
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
    const doc = stageElement?.ownerDocument ?? document
    const { x, y } = pointerRef.current
    const target = doc.elementFromPoint(x, y)
    if (!target) return false

    return Boolean(
      target.closest('[data-voice-stage-chrome]') ??
        target.closest('[data-voice-stage-popover]'),
    )
  }, [stageElement])

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
    if (!stageElement) return

    const onPointerActivity = (event: PointerEvent) => {
      pointerRef.current = { x: event.clientX, y: event.clientY }
      revealChrome()
    }

    const onFocusIn = () => {
      revealChrome()
    }

    stageElement.addEventListener('pointermove', onPointerActivity)
    stageElement.addEventListener('pointerdown', onPointerActivity)
    stageElement.addEventListener('pointerenter', onPointerActivity)
    stageElement.addEventListener('focusin', onFocusIn)

    revealChrome()

    return () => {
      stageElement.removeEventListener('pointermove', onPointerActivity)
      stageElement.removeEventListener('pointerdown', onPointerActivity)
      stageElement.removeEventListener('pointerenter', onPointerActivity)
      stageElement.removeEventListener('focusin', onFocusIn)
      clearHideTimer()
    }
  }, [attachKey, clearHideTimer, revealChrome, stageElement])

  return { stageRef, chromeVisible, revealChrome }
}
