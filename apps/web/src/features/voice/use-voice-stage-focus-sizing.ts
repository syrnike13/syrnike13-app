import { useEffect, useMemo, useState, type RefObject } from 'react'

import {
  computeVoiceStageFocusLayout,
  type VoiceStageFocusLayout,
} from '#/features/voice/voice-stage-focus-sizing'

const EMPTY_LAYOUT: VoiceStageFocusLayout = {
  focus: { width: 0, height: 0 },
  stripTile: { width: 0, height: 0 },
}

export function useVoiceStageFocusSizing(
  containerRef: RefObject<HTMLElement | null>,
  aspectRatio: number,
  stripItemCount: number,
  stripCollapsed: boolean,
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

  return useMemo(() => {
    const { width, height } = containerSize
    if (width <= 0 || height <= 0) {
      return {
        layout: EMPTY_LAYOUT,
        stripMetrics: EMPTY_LAYOUT.stripTile,
      }
    }

    const expandedLayout =
      stripItemCount > 0
        ? computeVoiceStageFocusLayout(width, height, aspectRatio, stripItemCount, false)
        : computeVoiceStageFocusLayout(width, height, aspectRatio, 0, false)

    const collapsedLayout = computeVoiceStageFocusLayout(
      width,
      height,
      aspectRatio,
      0,
      stripItemCount > 0 && stripCollapsed,
    )

    return {
      layout: stripCollapsed ? collapsedLayout : expandedLayout,
      stripMetrics: expandedLayout.stripTile,
    }
  }, [
    aspectRatio,
    containerSize.height,
    containerSize.width,
    stripCollapsed,
    stripItemCount,
  ])
}
