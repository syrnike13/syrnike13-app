import type { ComponentType, SVGProps } from 'react'

/** Общие props для любой SVG-иконки (Remix, Phosphor, Lucide, custom). */
export type AppIconProps = SVGProps<SVGSVGElement> & {
  size?: number | string
  color?: string
}

export type AppIcon = ComponentType<AppIconProps>

export type IconPack =
  | 'remixicon'
  | 'iconoir'
  | 'iconify'
  | 'phosphor'
  | 'lucide'
  | 'custom'

export type IconSource = {
  pack: IconPack
  /** Имя в исходном пакете, напр. `RiMicFill` или `Microphone` */
  name: string
}

export type DefinedIcon = AppIcon & {
  readonly __source: IconSource
}
