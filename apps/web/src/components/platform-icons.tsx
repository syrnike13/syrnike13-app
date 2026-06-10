import type { SVGProps } from 'react'

import type { DesktopPlatform } from '#/lib/config'
import { AppleIcon, LinuxIcon, WindowsIcon } from '#/components/icons'

export { AppleIcon, LinuxIcon, WindowsIcon }

export function PlatformIcon({
  platform,
  ...props
}: { platform: DesktopPlatform } & SVGProps<SVGSVGElement>) {
  if (platform === 'windows') return <WindowsIcon {...props} />
  if (platform === 'macos') return <AppleIcon {...props} />
  return <LinuxIcon {...props} />
}
