import { useRef, type ReactNode } from 'react'

import {
  chunkIntoRows,
  type VoiceStageGridLayout,
} from '#/features/voice/voice-stage-grid-layout'
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
  const rows = chunkIntoRows(slots, layout.columns)

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
          'flex flex-col items-center',
          layout.scroll ? 'mx-auto py-1' : 'm-auto',
        )}
        style={{ gap: layout.gap }}
      >
        {rows.map((row, rowIndex) => (
          <VoiceStageGridRow key={rowIndex} slots={row} layout={layout} />
        ))}
      </div>
    </div>
  )
}

function VoiceStageGridRow({
  slots,
  layout,
}: {
  slots: GridSlot[]
  layout: VoiceStageGridLayout
}) {
  return (
    <div
      className="flex shrink-0 items-center justify-center"
      style={{ gap: layout.gap }}
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
  )
}
