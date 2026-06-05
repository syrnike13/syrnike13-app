import { ChevronDownIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '#/components/ui/button'
import {
  voiceStageFilmstripSpacingClass,
  voiceStageFilmstripTightTopClass,
} from '#/components/voice/voice-stage-layout'
import type { VoiceStageMediaItem } from '#/features/voice/voice-provider'
import { cn } from '#/lib/utils'

type VoiceStageFilmstripProps = {
  items: readonly VoiceStageMediaItem[]
  focusedMediaId: string
  tightTop?: boolean
  tileWidth: number
  tileHeight: number
  renderTile: (item: VoiceStageMediaItem, variant: 'strip') => ReactNode
  onCollapse?: () => void
}

const voiceStageFilmstripCollapseButtonClass =
  'absolute top-0 left-1/2 z-30 size-7 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/10 bg-[#1e1f22]/95 text-white/70 shadow-sm hover:bg-white/10 hover:text-white'

export function VoiceStageFilmstrip({
  items,
  focusedMediaId,
  tightTop = false,
  tileWidth,
  tileHeight,
  renderTile,
  onCollapse,
}: VoiceStageFilmstripProps) {
  const stripItems = items.filter((item) => item.id !== focusedMediaId)
  if (stripItems.length === 0) return null

  const many = stripItems.length > 4
  const tileStyle =
    tileWidth > 0 && tileHeight > 0
      ? { width: tileWidth, height: tileHeight }
      : undefined

  return (
    <div
      className={cn(
        'relative shrink-0',
        many &&
          'before:pointer-events-none before:absolute before:inset-y-0 before:left-0 before:z-10 before:w-4 before:bg-gradient-to-r before:from-black/80 before:to-transparent',
        many &&
          'after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:z-10 after:w-6 after:bg-gradient-to-l after:from-black/80 after:to-transparent',
      )}
    >
      {onCollapse ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={voiceStageFilmstripCollapseButtonClass}
          title="Скрыть превью"
          aria-label="Скрыть превью других трансляций"
          onClick={onCollapse}
        >
          <ChevronDownIcon className="size-4" />
        </Button>
      ) : null}
      {many ? (
        <span className="pointer-events-none absolute top-0 right-1 z-20 rounded bg-black/75 px-1.5 py-px text-[10px] font-semibold tabular-nums text-white/90">
          +{stripItems.length}
        </span>
      ) : null}
      <div
        className={cn(
          'overflow-x-auto overscroll-x-contain scroll-smooth py-0.5',
          '[scrollbar-width:thin] [&::-webkit-scrollbar]:h-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/20',
          many && 'px-1',
        )}
      >
        <div
          role="list"
          aria-label="Другие трансляции в канале"
          className={cn(
            'mx-auto flex w-max min-w-full items-center justify-center',
            tightTop
              ? voiceStageFilmstripTightTopClass
              : voiceStageFilmstripSpacingClass,
          )}
        >
          {stripItems.map((item) => (
            <div
              key={item.id}
              role="listitem"
              className="shrink-0"
              style={tileStyle}
            >
              {renderTile(item, 'strip')}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
