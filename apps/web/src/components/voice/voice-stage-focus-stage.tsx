import { useEffect, useRef, useState, type ReactNode } from 'react'

import { VoiceStageFilmstrip } from '#/components/voice/voice-stage-filmstrip'
import { voiceStageFocusStackGapClass } from '#/components/voice/voice-stage-layout'
import type { VoiceStageMediaItem } from '#/features/voice/voice-provider'
import { useVoiceStageFocusSizing } from '#/features/voice/use-voice-stage-focus-sizing'
import { cn } from '#/lib/utils'

const DEFAULT_STREAM_ASPECT_RATIO = 16 / 9

type VoiceStageFocusStageProps = {
  focusedItem: VoiceStageMediaItem
  mediaItems: readonly VoiceStageMediaItem[]
  renderTile: (
    item: VoiceStageMediaItem,
    variant: 'focus' | 'strip',
    onStreamAspectRatioChange?: (aspectRatio: number) => void,
  ) => ReactNode
}

export function VoiceStageFocusStage({
  focusedItem,
  mediaItems,
  renderTile,
}: VoiceStageFocusStageProps) {
  const layoutRef = useRef<HTMLDivElement>(null)
  const [streamAspectRatio, setStreamAspectRatio] = useState(
    DEFAULT_STREAM_ASPECT_RATIO,
  )
  const stripItems = mediaItems.filter((item) => item.id !== focusedItem.id)
  const layout = useVoiceStageFocusSizing(
    layoutRef,
    streamAspectRatio,
    stripItems.length,
  )

  useEffect(() => {
    setStreamAspectRatio(DEFAULT_STREAM_ASPECT_RATIO)
  }, [focusedItem.id])

  return (
    <div
      ref={layoutRef}
      className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-x-hidden"
    >
      <div
        className={cn(
          'flex max-w-full shrink-0 flex-col items-center',
          voiceStageFocusStackGapClass,
        )}
      >
        <div
          className="max-w-full shrink-0 overflow-hidden rounded-md"
          style={
            layout.focus.width > 0 && layout.focus.height > 0
              ? { width: layout.focus.width, height: layout.focus.height }
              : { width: '100%', maxWidth: '75rem', aspectRatio: streamAspectRatio }
          }
        >
          {renderTile(focusedItem, 'focus', setStreamAspectRatio)}
        </div>

        {stripItems.length > 0 ? (
          <VoiceStageFilmstrip
            items={mediaItems}
            focusedMediaId={focusedItem.id}
            tightTop
            tileWidth={layout.stripTile.width}
            tileHeight={layout.stripTile.height}
            renderTile={renderTile}
          />
        ) : null}
      </div>
    </div>
  )
}
