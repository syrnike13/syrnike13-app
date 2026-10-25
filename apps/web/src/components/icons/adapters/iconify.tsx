import { Icon, type IconifyIcon } from '@iconify/react'
import { forwardRef, type ComponentProps } from 'react'

import bundledIcons from '#/components/icons/iconify-icons.json'
import type { AppIcon, AppIconProps } from '#/components/icons/types'

const ICONS: Record<string, IconifyIcon> = bundledIcons

/**
 * Обёртка для иконок iconify.design (Material Symbols, Lucide и др.).
 * Данные иконок лежат в проекте (`iconify-icons.json`, собирается
 * `pnpm --filter @syrnike13/web icons:build`), запросов к API iconify нет.
 */
export function iconifyIcon(iconId: string): AppIcon {
  const data = ICONS[iconId]
  if (!data) {
    throw new Error(
      `Icon ${iconId} is not bundled: run pnpm --filter @syrnike13/web icons:build`,
    )
  }
  const Component = forwardRef<SVGSVGElement, AppIconProps>(
    function IconifyIcon(props, ref) {
      const iconProps = props as unknown as Omit<ComponentProps<typeof Icon>, 'icon'>
      return <Icon ref={ref} icon={data} {...iconProps} />
    },
  )
  Component.displayName = iconId
  return Component as AppIcon
}
