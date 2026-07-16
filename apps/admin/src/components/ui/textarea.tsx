import * as React from 'react'

import { cn } from '#/lib/utils.ts'

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content min-h-20 w-full rounded-md border border-border/80 bg-input px-3 py-2.5 text-[13px] text-foreground transition-colors outline-none placeholder:text-muted-foreground/80 disabled:cursor-not-allowed disabled:opacity-50',
        'focus-visible:border-ring/70 focus-visible:ring-2 focus-visible:ring-ring/30',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20',
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
