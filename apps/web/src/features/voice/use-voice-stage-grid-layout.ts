import { useEffect, useMemo, useState, type RefObject } from 'react'

import {
  computeVoiceStageGridLayout,
  EMPTY_VOICE_STAGE_GRID_LAYOUT,
  type VoiceStageGridLayout,
} from '#/features/voice/voice-stage-grid-layout'

/**
 * Измеряет область сетки и возвращает раскладку плиток (Discord-like).
 * Пересчитывается при ресайзе контейнера и изменении числа плиток.
 */
export function useVoiceStageGridLayout(
  containerRef: RefObject<HTMLElement | null>,
  count: number,
): VoiceStageGridLayout {
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const element = containerRef.current
    if (!element) return

    const update = () => {
      setSize({
        width: Math.floor(element.clientWidth),
        height: Math.floor(element.clientHeight),
      })
    }

    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [containerRef])

  return useMemo(() => {
    if (count <= 0 || size.width <= 0 || size.height <= 0) {
      return EMPTY_VOICE_STAGE_GRID_LAYOUT
    }
    return computeVoiceStageGridLayout({
      width: size.width,
      height: size.height,
      count,
    })
  }, [count, size.height, size.width])
}
