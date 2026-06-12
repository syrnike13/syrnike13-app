import { Icon } from '@iconify/react'
import { forwardRef, type ComponentProps } from 'react'

import type { AppIcon, AppIconProps } from '#/components/icons/types'

/** Обёртка для иконок с iconify.design (Material Symbols, и др.). */
export function iconifyIcon(iconId: string): AppIcon {
  const Component = forwardRef<SVGSVGElement, AppIconProps>(
    function IconifyIcon(props, ref) {
      const iconProps = props as unknown as Omit<ComponentProps<typeof Icon>, 'icon'>
      return <Icon ref={ref} icon={iconId} {...iconProps} />
    },
  )
  Component.displayName = iconId
  return Component as AppIcon
}
