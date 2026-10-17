import { useRef, type ReactNode } from 'react'

import { useVoiceStageGridLayout } from '#/features/voice/use-voice-stage-grid-layout'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'

type GridSlot = {
  key: string
  node: ReactNode
}

type VoiceStageGridItem = Readonly<{ id: string }>

type VoiceStageGridProps<TItem extends VoiceStageGridItem> = {
  items: readonly TItem[]
  inviteSlot?: ReactNode
  renderTile: (item: TItem, variant: 'grid') => ReactNode
}

export function VoiceStageGrid<TItem extends VoiceStageGridItem>({
  items,
  inviteSlot,
  renderTile,
}: VoiceStageGridProps<TItem>) {
  const containerRef = useRef<HTMLDivElement>(null)
  const slots: GridSlot[] = items.map((item) => ({
    key: item.id,
    node: renderTile(item, 'grid'),
  }))
  if (inviteSlot) {
    slots.push({ key: '__invite__', node: inviteSlot })
  }

  const layout = useVoiceStageGridLayout(containerRef, slots.length)
  const contentWidth =
    layout.columns > 0
      ? layout.columns * layout.tileWidth +
        Math.max(0, layout.columns - 1) * layout.gap
      : 0

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative mx-auto flex min-h-0 w-full max-w-384 flex-1 flex-col',
        layout.scroll
          ? 'overflow-y-auto overflow-x-hidden scrollbar-thin [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-on-media/20'
          : 'overflow-hidden',
      )}
    >
      <div
        className={cn(
          'flex flex-wrap items-center justify-center gap-(--stage-gap) p-(--stage-padding)',
          layout.scroll ? 'mx-auto' : 'm-auto',
          contentWidth > 0 && 'w-(--stage-width)',
        )}
        style={
          {
            '--stage-width':
              contentWidth > 0
                ? `${contentWidth + layout.edgeInset * 2}px`
                : undefined,
            '--stage-gap': `${layout.gap}px`,
            '--stage-padding': `${layout.edgeInset}px`,
          } as CSSVars
        }
      >
        {slots.map((slot) => (
          <div
            key={slot.key}
            className="h-(--tile-height) w-(--tile-width) shrink-0"
            style={
              {
                '--tile-width': `${layout.tileWidth}px`,
                '--tile-height': `${layout.tileHeight}px`,
              } as CSSVars
            }
          >
            {slot.node}
          </div>
        ))}
      </div>
    </div>
  )
}
