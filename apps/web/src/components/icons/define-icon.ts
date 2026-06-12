import type { AppIcon, DefinedIcon, IconSource } from '#/components/icons/types'

/**
 * Регистрирует иконку приложения из любого пакета.
 * Меняй только импорт и `source` в registry — UI импортирует стабильные имена (`MicIcon`, …).
 */
export function defineIcon(
  component: unknown,
  source: IconSource,
): DefinedIcon {
  const icon = component as AppIcon as DefinedIcon
  if (icon.__source) {
    return icon
  }
  Object.defineProperty(icon, '__source', {
    value: source,
    writable: false,
    configurable: false,
    enumerable: false,
  })
  if (import.meta.env.DEV && !icon.displayName) {
    icon.displayName = `${source.name}@${source.pack}`
  }
  return icon
}
