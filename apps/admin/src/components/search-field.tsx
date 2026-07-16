import type { ComponentProps } from 'react'

import { SearchIcon } from '#/components/icons'
import { Input } from '#/components/ui/input'
import { cn } from '#/lib/utils'

export function SearchField({
  className,
  ...props
}: ComponentProps<typeof Input>) {
  return (
    <div className={cn('relative min-w-0', className)}>
      <SearchIcon
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input className="pl-9" {...props} />
    </div>
  )
}
