// design-allow-file restyle-shared: the voice-stage popover surface is shared by
// PopoverContent consumers and intentionally pins one Prism surface (popover
// background, shell divider ring, elevated shadow) for all of them.
import { cn } from '#/lib/utils'

/**
 * Поверхность поповеров на голосовой сцене — Prism-роль `popover`.
 */
const voiceStagePopoverSurfaceClass =
  'border-border bg-popover text-popover-foreground shadow-xl ring-1 ring-shell-divider'

/** Общий контейнер поповеров на голосовой сцене (поверх дефолтного PopoverContent). */
export const voiceStagePopoverContentClass = cn(
  'z-420 overflow-visible p-2 text-sm',
  voiceStagePopoverSurfaceClass,
)

export const voiceStagePopoverMicSettingsClass = cn(
  voiceStagePopoverContentClass,
  'w-64',
)

export const voiceStagePopoverSettingsClass = cn(
  voiceStagePopoverContentClass,
  'w-72',
)

/** Строка с подзаголовком (устройство, профиль). */
export const voiceStagePopoverNavRowClass = cn(
  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150',
  'hover:bg-accent/70 focus-visible:bg-accent/70 focus-visible:outline-none',
)

/** Пункт внутри подменю. */
export const voiceStagePopoverMenuItemClass = cn(
  'group flex h-8 w-full min-w-0 items-center gap-2 rounded-sm px-2.5 text-left text-sm leading-tight text-foreground transition-colors duration-150',
  'hover:bg-hover focus-visible:bg-hover focus-visible:outline-none data-popup-open:bg-hover',
  'disabled:pointer-events-none disabled:opacity-50',
)

export const voiceStagePopoverSectionTitleClass =
  'text-xs font-semibold text-foreground'

export const voiceStagePopoverHintClass =
  'text-xs leading-snug text-muted-foreground'
