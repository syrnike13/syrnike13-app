import {
  ContextMenuGroup,
  ContextMenuLabel,
} from '@syrnike13/ui/primitives/context-menu'
import { Slider } from '@syrnike13/ui/primitives/slider'

/**
 * Volume slider row inside a context menu (participant, stream). Pointer
 * events stop here so dragging does not close the menu.
 */
export function ContextMenuVolume({
  label,
  value,
  max,
  step,
  valueLabel,
  onValueChange,
}: {
  label: string
  value: number
  max: number
  step: number
  valueLabel: string
  onValueChange: (value: number) => void
}) {
  return (
    <ContextMenuGroup
      className="px-2 py-2"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <ContextMenuLabel className="px-0 pb-2">{label}</ContextMenuLabel>
      <div className="flex items-center gap-2">
        <Slider
          className="flex-1"
          aria-label={label}
          min={0}
          max={max}
          step={step}
          value={[value]}
          onValueChange={(next) => {
            const resolved = typeof next === 'number' ? next : next[0]
            if (resolved != null) onValueChange(resolved)
          }}
        />
        <span className="w-10 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
          {valueLabel}
        </span>
      </div>
    </ContextMenuGroup>
  )
}
