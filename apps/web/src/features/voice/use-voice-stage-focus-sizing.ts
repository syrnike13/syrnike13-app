import { useEffect, useMemo, useState, type RefObject } from 'react'

import { computeVoiceStageFocusLayout } from '#/features/voice/voice-stage-focus-sizing'

export function useVoiceStageFocusSizing(
  containerRef: RefObject<HTMLElement | null>,
  aspectRatio: number,
  stripCount: number,
  collapsedStripChrome = false,
) {
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const element = containerRef.current
    if (!element) return

    const update = () => {
      const rect = element.getBoundingClientRect()
      setContainerSize({
        width: Math.floor(rect.width),
        height: Math.floor(rect.height),
      })
    }

    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [containerRef])

  return useMemo(
    () =>
      computeVoiceStageFocusLayout(
        containerSize.width,
        containerSize.height,
        aspectRatio,
        stripCount,
        collapsedStripChrome,
      ),
    [
      aspectRatio,
      collapsedStripChrome,
      containerSize.height,
      containerSize.width,
      stripCount,
    ],
  )
}
