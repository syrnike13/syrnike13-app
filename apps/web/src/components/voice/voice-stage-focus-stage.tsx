import { ChevronDownIcon, ChevronUpIcon, UsersIcon } from '#/components/icons'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { VoiceStageFilmstrip } from '#/components/voice/voice-stage-filmstrip'
import { voiceStageFocusStackGapClass } from '#/components/voice/voice-stage-layout'
import { useVoiceStageFocusSizing } from '#/features/voice/use-voice-stage-focus-sizing'
import { voiceStageChromeMotion } from '#/features/voice/use-voice-stage-chrome-visible'
import { cn } from '#/lib/utils'

const DEFAULT_STREAM_ASPECT_RATIO = 16 / 9

const focusStageFadeSlideClass =
  'transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none'

const voiceStageStripToggleButtonClass =
  'inline-flex shrink-0 items-center justify-center rounded-full border border-white/10 bg-card px-2 text-sm font-medium text-primary-foreground/80 shadow-sm transition-colors hover:bg-muted hover:text-primary-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 h-7 gap-0.5'

const FOCUS_STRIP_GAP_PX = 8
const STRIP_TOGGLE_SIZE_PX = 28
const STRIP_TOGGLE_INSET_PX = 8

function stripToggleTopPx(focusHeight: number, stripCollapsed: boolean) {
  if (focusHeight <= 0) return undefined

  if (stripCollapsed) {
    return focusHeight - STRIP_TOGGLE_INSET_PX - STRIP_TOGGLE_SIZE_PX
  }

  return focusHeight + FOCUS_STRIP_GAP_PX - STRIP_TOGGLE_SIZE_PX / 2
}

type VoiceStageFocusItem = Readonly<{ id: string }>

type VoiceStageFocusStageProps<TItem extends VoiceStageFocusItem> = {
  focusedItem: TItem
  mediaItems: readonly TItem[]
  chromeVisible: boolean
  renderTile: (
    item: TItem,
    variant: 'focus' | 'strip',
    onStreamAspectRatioChange?: (aspectRatio: number) => void,
  ) => ReactNode
}

export function VoiceStageFocusStage<TItem extends VoiceStageFocusItem>({
  focusedItem,
  mediaItems,
  chromeVisible,
  renderTile,
}: VoiceStageFocusStageProps<TItem>) {
  const layoutRef = useRef<HTMLDivElement>(null)
  const [streamAspectRatio, setStreamAspectRatio] = useState(
    DEFAULT_STREAM_ASPECT_RATIO,
  )
  const stripItems = mediaItems.filter((item) => item.id !== focusedItem.id)
  const [stripCollapsed, setStripCollapsed] = useState(false)
  const { layout, stripMetrics } = useVoiceStageFocusSizing(
    layoutRef,
    streamAspectRatio,
    stripItems.length,
    stripCollapsed,
  )

  useEffect(() => {
    setStreamAspectRatio(DEFAULT_STREAM_ASPECT_RATIO)
    setStripCollapsed(false)
  }, [focusedItem.id])

  const stripToggleTop = stripToggleTopPx(layout.focus.height, stripCollapsed)

  return (
    <div className="relative flex min-h-0 min-w-0 w-full flex-1">
      <div
        ref={layoutRef}
        className="pointer-events-none absolute inset-0"
        aria-hidden
      />
      <div className="relative flex min-h-0 min-w-0 w-full flex-1 items-center justify-center overflow-x-hidden">
        <div
          className={cn(
            'relative flex w-full max-w-full shrink-0 flex-col items-center',
            voiceStageFocusStackGapClass,
          )}
        >
          <div
            className="max-w-full shrink-0 transition-[width,height] duration-200 ease-out motion-reduce:transition-none"
            style={
              layout.focus.width > 0 && layout.focus.height > 0
                ? { width: layout.focus.width, height: layout.focus.height }
                : { width: '100%', aspectRatio: streamAspectRatio }
            }
          >
            <div className="size-full overflow-hidden rounded-md">
              {renderTile(focusedItem, 'focus', setStreamAspectRatio)}
            </div>
          </div>

          {stripItems.length > 0 ? (
            <div
              className="grid w-full transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
              style={{ gridTemplateRows: stripCollapsed ? '0fr' : '1fr' }}
            >
              <div className="overflow-hidden">
                <div
                  className={cn(
                    focusStageFadeSlideClass,
                    stripCollapsed
                      ? 'pointer-events-none opacity-0 translate-y-2'
                      : 'opacity-100 translate-y-0',
                  )}
                  aria-hidden={stripCollapsed}
                >
                  <VoiceStageFilmstrip
                    items={mediaItems}
                    focusedMediaId={focusedItem.id}
                    tightTop
                    tileWidth={stripMetrics.width}
                    tileHeight={stripMetrics.height}
                    renderTile={renderTile}
                  />
                </div>
              </div>
            </div>
          ) : null}

          {stripItems.length > 0 && stripToggleTop != null ? (
            <div
              data-voice-stage-chrome
              className="pointer-events-none absolute left-1/2 z-30 -translate-x-1/2 transition-[top] duration-200 ease-out motion-reduce:transition-none"
              style={{ top: stripToggleTop }}
            >
              <div
                className={cn(
                  'pointer-events-auto',
                  voiceStageChromeMotion(chromeVisible, 'bottom'),
                )}
              >
                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className={voiceStageStripToggleButtonClass}
                        aria-label={
                          stripCollapsed
                            ? 'Показать участников'
                            : 'Убрать участников'
                        }
                        onClick={() => setStripCollapsed((value) => !value)}
                      >
                        {stripCollapsed ? (
                          <ChevronUpIcon className="size-3.5 shrink-0" />
                        ) : (
                          <ChevronDownIcon className="size-3.5 shrink-0" />
                        )}
                        <UsersIcon className="size-3.5 shrink-0" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={8}>
                      {stripCollapsed
                        ? 'Показать участников'
                        : 'Убрать участников'}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
