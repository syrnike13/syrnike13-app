import type { ReactNode } from 'react'

import { Label } from '#/components/ui/label'
import { cn } from '#/lib/utils'

export function FormField({
  label,
  hint,
  children,
  className,
}: {
  label: string
  hint?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label className="text-[12px] text-muted-foreground">{label}</Label>
      {hint ? <p className="text-[11px] text-muted-foreground/80">{hint}</p> : null}
      {children}
    </div>
  )
}
