import { useEffect, useState, type RefObject } from 'react'

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
  stripCount: number,
) {
  const [layout, setLayout] = useState<VoiceStageFocusLayout>(EMPTY_LAYOUT)

  useEffect(() => {
    const element = containerRef.current
    if (!element) return

    const update = () => {
      const rect = element.getBoundingClientRect()
      setLayout(
        computeVoiceStageFocusLayout(
          rect.width,
          rect.height,
          aspectRatio,
          stripCount,
        ),
      )
    }

    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [aspectRatio, containerRef, stripCount])

  return layout
}
