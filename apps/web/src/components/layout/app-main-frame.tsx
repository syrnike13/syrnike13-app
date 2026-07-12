import type { ReactNode } from 'react'

import { shellDivider, shellContentSurface, shellNavSurface } from '#/components/layout/shell-chrome'

type AppMainFrameProps = {
  sidebar: ReactNode
  children: ReactNode
}

export function AppMainFrame({ sidebar, children }: AppMainFrameProps) {
  return (
    <div
      className={`flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-tl-xl rounded-tr-none rounded-br-none rounded-bl-none border shadow-sm ${shellDivider} ${shellNavSurface}`}
    >
      {sidebar}
      <div
        className={`flex min-h-0 min-w-0 flex-1 flex-col border-l ${shellContentSurface} ${shellDivider}`}
      >
        {children}
      </div>
    </div>
  )
}
