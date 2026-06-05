import { profileMenuRowClass } from '#/components/user/profile-menu-row'
import { cn } from '#/lib/utils'

/**
 * Поверхность поповеров на голосовой сцене — темнее обычного `popover`,
 * ближе к панели контролов (`#1e1f22`), но через токен темы.
 */
const voiceStagePopoverSurfaceClass =
  'border-border bg-sidebar text-popover-foreground shadow-xl ring-1 ring-shell-divider'

/** Общий контейнер поповеров на голосовой сцене (поверх дефолтного PopoverContent). */
export const voiceStagePopoverContentClass = cn(
  'z-[420] overflow-visible p-2 text-sm',
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

/** Вложенное подменю справа от строки. */
export const voiceStagePopoverSubmenuClass = cn(
  'absolute top-0 left-full z-[430] ml-1 w-56 rounded-md p-1',
  voiceStagePopoverSurfaceClass,
)

/** Строка с подзаголовком (устройство, профиль). */
export const voiceStagePopoverNavRowClass = cn(
  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-150',
  'hover:bg-accent/70 focus-visible:bg-accent/70 focus-visible:outline-none',
)

/** Пункт внутри подменю. */
export const voiceStagePopoverMenuItemClass = cn(
  profileMenuRowClass,
  'text-foreground',
)

export const voiceStagePopoverSectionTitleClass =
  'text-xs font-semibold text-foreground'

export const voiceStagePopoverHintClass =
  'text-[11px] leading-snug text-muted-foreground'

export const voiceStagePopoverSeparatorClass = 'my-0.5 h-px bg-border'

export const voiceStagePopoverCheckboxClass =
  'size-4 shrink-0 rounded border-input accent-primary'
