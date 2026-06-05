import { ChevronUpIcon } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { Button } from '#/components/ui/button'
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
  const [stripCollapsed, setStripCollapsed] = useState(false)
  const layout = useVoiceStageFocusSizing(
    layoutRef,
    streamAspectRatio,
    stripCollapsed ? 0 : stripItems.length,
    stripCollapsed,
  )

  useEffect(() => {
    setStreamAspectRatio(DEFAULT_STREAM_ASPECT_RATIO)
    setStripCollapsed(false)
  }, [focusedItem.id])

  return (
    <div className="relative flex min-h-0 min-w-0 w-full flex-1">
      <div ref={layoutRef} className="pointer-events-none absolute inset-0" aria-hidden />
      <div className="relative flex min-h-0 min-w-0 w-full flex-1 items-center justify-center overflow-x-hidden">
        <div
          className={cn(
            'flex w-full max-w-full shrink-0 flex-col items-center',
            voiceStageFocusStackGapClass,
          )}
        >
          <div
            className="max-w-full shrink-0 overflow-hidden rounded-md"
            style={
              layout.focus.width > 0 && layout.focus.height > 0
                ? { width: layout.focus.width, height: layout.focus.height }
                : { width: '100%', aspectRatio: streamAspectRatio }
            }
          >
            {renderTile(focusedItem, 'focus', setStreamAspectRatio)}
          </div>

        {stripItems.length > 0 && stripCollapsed ? (
          <div className="flex shrink-0 justify-center">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 rounded-full border border-white/10 bg-[#1e1f22]/95 text-white/70 shadow-sm hover:bg-white/10 hover:text-white"
              title="Показать превью"
              aria-label="Показать превью других трансляций"
              onClick={() => setStripCollapsed(false)}
            >
              <ChevronUpIcon className="size-4" />
            </Button>
          </div>
        ) : null}

        {stripItems.length > 0 && !stripCollapsed ? (
          <VoiceStageFilmstrip
            items={mediaItems}
            focusedMediaId={focusedItem.id}
            tightTop
            tileWidth={layout.stripTile.width}
            tileHeight={layout.stripTile.height}
            renderTile={renderTile}
            onCollapse={() => setStripCollapsed(true)}
          />
        ) : null}
        </div>
      </div>
    </div>
  )
}
