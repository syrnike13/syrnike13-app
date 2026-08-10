import { useRef, type ReactNode } from 'react'

import { useVoiceStageGridLayout } from '#/features/voice/use-voice-stage-grid-layout'
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
        'relative mx-auto flex min-h-0 w-full max-w-[96rem] flex-1 flex-col',
        layout.scroll
          ? 'overflow-y-auto overflow-x-hidden [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/20'
          : 'overflow-hidden',
      )}
    >
      <div
        className={cn(
          'flex flex-wrap items-center justify-center',
          layout.scroll ? 'mx-auto' : 'm-auto',
        )}
        style={{
          width: contentWidth > 0
            ? contentWidth + layout.edgeInset * 2
            : undefined,
          gap: layout.gap,
          padding: layout.edgeInset,
        }}
      >
        {slots.map((slot) => (
          <div
            key={slot.key}
            className="shrink-0"
            style={{ width: layout.tileWidth, height: layout.tileHeight }}
          >
            {slot.node}
          </div>
        ))}
      </div>
    </div>
  )
}
