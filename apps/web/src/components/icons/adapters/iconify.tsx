import { Icon } from '@iconify/react'
import { forwardRef } from 'react'

import type { AppIcon, AppIconProps } from '#/components/icons/types'

/** Обёртка для иконок с iconify.design (Material Symbols, и др.). */
export function iconifyIcon(iconId: string): AppIcon {
  const Component = forwardRef<SVGSVGElement, AppIconProps>(
    function IconifyIcon(props, ref) {
      return <Icon ref={ref} icon={iconId} {...props} />
    },
  )
  Component.displayName = iconId
  return Component as AppIcon
}
