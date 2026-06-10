import type { DefinedIcon, IconSource } from '#/components/icons/types'

/** Метаданные иконки из registry (для отладки и будущего icon picker). */
export function getIconSource(icon: DefinedIcon): IconSource {
  return icon.__source
}
