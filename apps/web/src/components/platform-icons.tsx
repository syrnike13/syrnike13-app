import type { SVGProps } from 'react'

import type { DesktopPlatform } from '#/lib/config'

export function WindowsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden {...props}>
      <path d="M0 2.4 6.5 1.5V7.5H0V2.4ZM7.4 1.4 16 0.2V7.5H7.4V1.4ZM0 8.5H6.5V14.5L0 13.6V8.5ZM7.4 8.5H16V15.8L7.4 14.6V8.5Z" />
    </svg>
  )
}

export function AppleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 14 16" fill="currentColor" aria-hidden {...props}>
      <path d="M11.2 8.4c0-1.7 1.4-2.5 1.5-2.6-0.8-1.2-2.1-1.3-2.5-1.4-1.1-0.1-2.1 0.6-2.6 0.6-0.5 0-1.4-0.6-2.3-0.6-1.2 0-2.3 0.7-2.9 1.8-1.2 2.1-0.3 5.3 0.9 7 0.6 0.8 1.3 1.8 2.2 1.7 0.9 0 1.2-0.6 2.3-0.6s1.4 0.6 2.3 0.5c0.9 0 1.6-0.8 2.2-1.7 0.7-1 1-1.9 1-2-0.1 0-1.9-0.7-1.9-2.7zM9.4 3.3c0.5-0.6 0.8-1.4 0.7-2.3-0.7 0-1.5 0.5-2 1-0.4 0.5-0.8 1.3-0.7 2.1 0.8 0.1 1.5-0.4 2-0.8z" />
    </svg>
  )
}

export function LinuxIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 14 16" fill="currentColor" aria-hidden {...props}>
      <path d="M7 0.5c-1.6 0-2.7 1.4-2.7 3.2 0 0.9 0.2 1.6 0.2 2.3 0 0.8-0.9 1.6-1.5 2.7-0.6 1.1-1.3 2.3-1.3 3.6 0 0.5 0.2 0.9 0.6 1.1-0.1 0.4 0 0.8 0.3 1 0.4 0.3 1.1 0.3 1.7 0.5 0.6 0.2 1 0.5 1.7 0.5 0.3 0 0.5-0.1 0.7-0.2 0.2 0.1 0.4 0.2 0.7 0.2 0.7 0 1.1-0.3 1.7-0.5 0.6-0.2 1.3-0.2 1.7-0.5 0.3-0.2 0.4-0.6 0.3-1 0.4-0.2 0.6-0.6 0.6-1.1 0-1.3-0.7-2.5-1.3-3.6-0.6-1.1-1.5-1.9-1.5-2.7 0-0.7 0.2-1.4 0.2-2.3 0-1.8-1.1-3.2-2.8-3.2zm-1 3.1c0.3 0 0.5 0.3 0.5 0.7s-0.2 0.7-0.5 0.7-0.5-0.3-0.5-0.7 0.2-0.7 0.5-0.7zm2 0c0.3 0 0.5 0.3 0.5 0.7s-0.2 0.7-0.5 0.7-0.5-0.3-0.5-0.7 0.2-0.7 0.5-0.7z" />
    </svg>
  )
}

export function PlatformIcon({
  platform,
  ...props
}: { platform: DesktopPlatform } & SVGProps<SVGSVGElement>) {
  if (platform === 'windows') return <WindowsIcon {...props} />
  if (platform === 'macos') return <AppleIcon {...props} />
  return <LinuxIcon {...props} />
}
