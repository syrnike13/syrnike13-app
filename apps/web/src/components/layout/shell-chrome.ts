/** Фон колонки серверов / каналов — совпадает с рельсом. */
export const shellNavSurface =
  'bg-background text-foreground' as const

/** Кнопки рельса: квадрат с сильным скруглением (не круг). */
export const railIconButtonClass = 'size-10 rounded-xl' as const

/** Фон кнопок рельса: card заметнее background, hover — secondary. */
export const railIconIdleClass =
  'bg-card text-foreground hover:bg-secondary hover:text-foreground' as const

/** Разделители оболочки — полная непрозрачность. */
export const shellDivider = 'border-shell-divider' as const

/** Заголовок колонки (сайдбар канала, шапка канала): одна высота, липнет к верху. */
export const shellColumnHeaderClass =
  'sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b border-shell-divider' as const

/** Плавающие панели (UserPanel, композер): высота 52px + отступ bottom-2. */
export const FLOATING_BAR_HEIGHT_CLASS = 'min-h-[52px]' as const
export const FLOATING_BAR_BOTTOM_CLASS = 'bottom-2' as const
export const FLOATING_BAR_INSET_X_CLASS = 'inset-x-2' as const
export const FLOATING_BAR_SCROLL_PAD_CLASS = 'pb-[120px]' as const
export const floatingBarShellClass =
  'rounded-lg shadow-lg ring-1 ring-shell-divider' as const

/** Плавающий композер: одна «таблетка» (полоска ответа + поле ввода). */
export const floatingComposerShellClass =
  `${floatingBarShellClass} flex flex-col overflow-hidden bg-secondary text-secondary-foreground` as const
