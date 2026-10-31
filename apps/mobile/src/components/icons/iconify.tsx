import { useResolveClassNames } from 'uniwind'
import { SvgXml } from 'react-native-svg'

import bundledIcons from './iconify-icons.json'

type IconData = { body: string; width: number; height: number }

const ICONS: Record<string, IconData> = bundledIcons

export type IconProps = {
  /** Text color token, e.g. `text-muted-foreground`; icons draw in `currentColor`. */
  className?: string
  /** Edge length in dp. */
  size?: number
}

/**
 * Icon from an iconify set, bundled into `iconify-icons.json` by
 * `pnpm --filter @syrnike13/mobile icons:build`; nothing loads at runtime.
 */
export function iconifyIcon(iconId: string) {
  const data = ICONS[iconId]
  if (!data) {
    throw new Error(`Icon ${iconId} is not bundled: run pnpm --filter @syrnike13/mobile icons:build`)
  }
  const xml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${data.width} ${data.height}">${data.body}</svg>`

  function Icon({ className = 'text-foreground', size = 20 }: IconProps) {
    const { color } = useResolveClassNames(className)
    return <SvgXml xml={xml} width={size} height={size} color={color as string | undefined} />
  }
  Icon.displayName = iconId
  return Icon
}
