import type { DesktopOs } from '@syrnike13/platform'

/** Фон навигации: рельс, сайдбар, title bar. */
export const shellNavSurface =
  'bg-background text-foreground' as const

/** Фон основного контента (чат, канал). */
export const shellContentSurface =
  'bg-card text-card-foreground' as const

/** Высота кастомной шапки окна под каждую ОС (px). */
export const SHELL_TITLEBAR_HEIGHT_PX = {
  darwin: 36,
  win32: 32,
  linux: 32,
} as const satisfies Record<DesktopOs, number>

export function getShellTitleBarHeightPx(os: DesktopOs | null): number {
  if (!os) return 0
  return SHELL_TITLEBAR_HEIGHT_PX[os]
}

/** Ширина кнопок caption на Windows (px). */
export const SHELL_TITLEBAR_WIN32_BUTTON_WIDTH_PX = 46

/** Левый отступ стрелок навигации на Windows (px). */
export const SHELL_TITLEBAR_WIN32_NAV_INSET_PX = 8

/** Отступ слева под системные traffic lights на macOS. */
export const SHELL_TITLEBAR_MACOS_INSET_PX = 72

/** Совпадает с `trafficLightPosition` в Electron (`window.ts`). */
export const SHELL_TITLEBAR_MACOS_TRAFFIC_LIGHT_Y_PX = 12
export const SHELL_TITLEBAR_MACOS_TRAFFIC_LIGHT_SIZE_PX = 12

/** Размер кликабельной зоны стрелок на macOS. */
export const SHELL_TITLEBAR_MACOS_NAV_BUTTON_PX = 28

function getShellTitleBarMacosTrafficLightCenterPx(): number {
  return (
    SHELL_TITLEBAR_MACOS_TRAFFIC_LIGHT_Y_PX +
    SHELL_TITLEBAR_MACOS_TRAFFIC_LIGHT_SIZE_PX / 2
  )
}

/** Тонкая подстройка по вертикали относительно traffic lights. */
export const SHELL_TITLEBAR_MACOS_NAV_OPTICAL_OFFSET_PX = 1

/** top для блока навигации: центр совпадает с traffic lights. */
export function getShellTitleBarMacosNavTopPx(
  hitAreaHeightPx = SHELL_TITLEBAR_MACOS_NAV_BUTTON_PX,
): number {
  return (
    getShellTitleBarMacosTrafficLightCenterPx() -
    hitAreaHeightPx / 2 +
    SHELL_TITLEBAR_MACOS_NAV_OPTICAL_OFFSET_PX
  )
}

export const shellTitleBarDragClass = 'shell-title-bar-drag' as const
export const shellTitleBarNoDragClass = 'shell-title-bar-no-drag' as const

/** Кнопки рельса: квадрат с сильным скруглением (не круг). */
export const railIconButtonClass = 'size-10 rounded-xl' as const

/** Фон кнопок рельса: card заметнее background, hover — secondary. */
export const railIconIdleClass =
  'bg-card text-foreground hover:bg-secondary hover:text-foreground' as const

/** Горизонтальный inset колонки рельса (4px = w-1 индикатора с -left-1). */
export const railColumnInsetClass = 'px-1' as const

/**
 * ScrollArea серверов: сдвиг влево + шире на 4px,
 * чтобы RailActiveIndicator (-left-1) не обрезался overflow-hidden viewport.
 */
export const railServerScrollAreaClass =
  '-ml-1 w-[calc(100%+0.25rem)]' as const

/** Внутренний отступ контента ScrollArea — выравнивает кнопки с Home. */
export const railServerScrollContentClass = 'pl-1' as const

/** Обёртка квадратной кнопки рельса (RailIconButton). */
export const railIconItemRowClass =
  'group relative flex w-full justify-center' as const

/** Разделители оболочки — полная непрозрачность. */
export const shellDivider = 'border-shell-divider' as const

/** Заголовок колонки (сайдбар канала, шапка канала): одна высота, липнет к верху. */
export const shellColumnHeaderClass =
  'sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b border-shell-divider' as const

/** Плавающие панели (UserPanel, композер): высота строки + отступ bottom-2. */
export const FLOATING_BAR_HEIGHT_PX = 56
export const FLOATING_BAR_HEIGHT_CLASS = 'min-h-14' as const
export const FLOATING_BAR_FIXED_HEIGHT_CLASS = 'h-14' as const
export const FLOATING_BAR_BOTTOM_CLASS = 'bottom-2' as const
export const FLOATING_BAR_INSET_X_CLASS = 'inset-x-2' as const
export const FLOATING_BAR_SCROLL_PAD_CLASS = 'pb-[120px]' as const
export const floatingBarShellClass =
  'rounded-lg shadow-lg ring-1 ring-shell-divider' as const

/** Плавающий композер: одна «таблетка» (полоска ответа + поле ввода). */
export const floatingComposerShellClass =
  `${floatingBarShellClass} flex flex-col overflow-hidden bg-secondary text-secondary-foreground` as const
