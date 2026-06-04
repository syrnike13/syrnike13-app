import { cn } from '#/lib/utils'

/** Вложенный блок действий в поповере профиля. */
export const profileMenuNestClass =
  'mx-2 mb-2 flex min-w-0 flex-col gap-px overflow-hidden rounded-md bg-secondary p-1'

/** Строка внутри вложенного блока. */
export const profileMenuRowClass = cn(
  'group flex h-8 w-full min-w-0 items-center gap-2 rounded-[5px] px-2.5 text-left text-sm font-normal leading-tight',
  'text-muted-foreground transition-colors duration-150',
  'hover:bg-accent/70 hover:text-foreground',
  'active:bg-accent/80',
  'focus-visible:bg-accent/70 focus-visible:text-foreground focus-visible:outline-none',
  'data-[state=open]:bg-accent/60 data-[state=open]:text-foreground',
  'disabled:pointer-events-none disabled:opacity-50',
)
