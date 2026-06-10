/**
 * Единая точка входа для иконок приложения.
 *
 * UI импортирует только отсюда: `import { MicIcon } from '#/components/icons'`
 * Источник и пакет меняются в `registry/*` — по одной иконке.
 */
export type { AppIcon, AppIconProps, DefinedIcon, IconPack, IconSource } from '#/components/icons/types'
export { defineIcon } from '#/components/icons/define-icon'
export { getIconSource } from '#/components/icons/icon-source'
export * from '#/components/icons/registry'
