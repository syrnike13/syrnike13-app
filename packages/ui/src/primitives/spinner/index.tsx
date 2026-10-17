import type * as React from 'react'

import { cn } from '../../lib/cn'

type SpinnerProps = React.ComponentProps<'span'> & {
  label?: string
}

function Spinner({ className, label, ...props }: SpinnerProps) {
  return (
    <span
      data-slot="spinner"
      role="status"
      aria-label={label}
      className={cn(
        'inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent text-muted-foreground',
        className,
      )}
      {...props}
    >
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  )
}

export { Spinner }
