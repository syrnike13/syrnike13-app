import { ChevronDownIcon, ChevronUpIcon, UsersIcon } from '#/components/icons'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@syrnike13/ui/primitives/tooltip'
import { VoiceStageFilmstrip } from '#/components/voice/voice-stage-filmstrip'
import { voiceStageFocusStackGapClass } from '#/components/voice/voice-stage-layout'
import { useVoiceStageFocusSizing } from '#/features/voice/use-voice-stage-focus-sizing'
import { voiceStageChromeMotion } from '#/features/voice/use-voice-stage-chrome-visible'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'

const DEFAULT_STREAM_ASPECT_RATIO = 16 / 9

const focusStageFadeSlideClass =
  'transition duration-200 ease-out motion-reduce:transition-none'

const voiceStageStripToggleButtonClass =
  'inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-card px-2 text-sm font-medium text-card-foreground/80 shadow-sm transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 h-7 gap-0.5'

const FOCUS_STRIP_GAP_PX = 8
const STRIP_TOGGLE_SIZE_PX = 28
const STRIP_TOGGLE_INSET_PX = 8
const STRIP_EXIT_DURATION_MS = 200

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
  const t = useTranslations('voice')
  const layoutRef = useRef<HTMLDivElement>(null)
  const [streamAspectRatio, setStreamAspectRatio] = useState(
    DEFAULT_STREAM_ASPECT_RATIO,
  )
  const stripItems = mediaItems.filter((item) => item.id !== focusedItem.id)
  const [stripCollapsed, setStripCollapsed] = useState(false)
  const [stripMounted, setStripMounted] = useState(true)
  const { layout, stripMetrics } = useVoiceStageFocusSizing(
    layoutRef,
    streamAspectRatio,
    stripItems.length,
    stripCollapsed,
  )

  useEffect(() => {
    setStreamAspectRatio(DEFAULT_STREAM_ASPECT_RATIO)
    setStripCollapsed(false)
    setStripMounted(true)
  }, [focusedItem.id])

  useEffect(() => {
    if (!stripCollapsed) return
    const timer = setTimeout(
      () => setStripMounted(false),
      STRIP_EXIT_DURATION_MS,
    )
    return () => clearTimeout(timer)
  }, [stripCollapsed])

  const toggleStrip = () => {
    if (stripCollapsed) setStripMounted(true)
    setStripCollapsed((value) => !value)
  }

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
            className={cn(
              'max-w-full shrink-0 motion-size duration-200 ease-out motion-reduce:transition-none',
              layout.focus.width > 0 && layout.focus.height > 0
                ? 'h-(--focus-height) w-(--focus-width)'
                : 'aspect-(--focus-aspect) w-full',
            )}
            style={
              {
                '--focus-width': `${layout.focus.width}px`,
                '--focus-height': `${layout.focus.height}px`,
                '--focus-aspect': streamAspectRatio,
              } as CSSVars
            }
          >
            <div className="size-full overflow-hidden rounded-md">
              {renderTile(focusedItem, 'focus', setStreamAspectRatio)}
            </div>
          </div>

          {stripItems.length > 0 ? (
            <div
              className={cn(
                'grid w-full motion-rows duration-200 ease-out motion-reduce:transition-none',
                stripCollapsed ? 'collapsed-rows' : 'expanded-rows',
              )}
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
                  {stripMounted ? (
                    <VoiceStageFilmstrip
                      items={mediaItems}
                      focusedMediaId={focusedItem.id}
                      tightTop
                      tileWidth={stripMetrics.width}
                      tileHeight={stripMetrics.height}
                      renderTile={renderTile}
                    />
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}

          {stripItems.length > 0 && stripToggleTop != null ? (
            <div
              data-voice-stage-chrome
              className="pointer-events-none absolute left-1/2 z-30 -translate-x-1/2 top-(--strip-toggle-top) motion-top duration-200 ease-out motion-reduce:transition-none"
              style={{ '--strip-toggle-top': `${stripToggleTop}px` } as CSSVars}
            >
              <div
                className={cn(
                  'pointer-events-auto',
                  voiceStageChromeMotion(chromeVisible, 'bottom'),
                )}
              >
                <TooltipProvider delay={300}>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          className={voiceStageStripToggleButtonClass}
                          aria-label={
                            stripCollapsed
                              ? t('actions.showParticipants')
                              : t('actions.hideParticipants')
                          }
                          onClick={toggleStrip}
                        />
                      }
                    >
                      {stripCollapsed ? (
                        <ChevronUpIcon className="size-3.5 shrink-0" />
                      ) : (
                        <ChevronDownIcon className="size-3.5 shrink-0" />
                      )}
                      <UsersIcon className="size-3.5 shrink-0" />
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={8}>
                      {stripCollapsed
                        ? t('actions.showParticipants')
                        : t('actions.hideParticipants')}
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
