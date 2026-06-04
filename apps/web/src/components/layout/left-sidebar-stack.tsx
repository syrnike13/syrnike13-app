import type { ReactNode } from 'react'

/** Высота плавающей панели аккаунта (+ полоска войса) + отступ снизу. */
export const USER_PANEL_RESERVE_PX = 116

/** Рельс + сайдбар; right-2 — такой же зазор, как у left-2 на обёртке. */
export const USER_PANEL_SPAN_WIDTH = 'calc(3.5rem + 15rem - 0.5rem)'

type LeftSidebarStackProps = {
  children: ReactNode
}

export function LeftSidebarStack({ children }: LeftSidebarStackProps) {
  return (
    <div className="flex h-full min-h-0 w-60 shrink-0 flex-col">{children}</div>
  )
}
