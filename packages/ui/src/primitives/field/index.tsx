import * as React from 'react'

import { cn } from '../../lib/cn'
import { Label } from '../label'

type FieldProps = React.ComponentProps<'div'> & {
  label: React.ReactNode
  htmlFor?: string
  hint?: React.ReactNode
  error?: React.ReactNode
}

function Field({
  label,
  htmlFor,
  hint,
  error,
  className,
  children,
  ...props
}: FieldProps) {
  const generatedId = React.useId()
  const id = htmlFor ?? generatedId
  const control = React.isValidElement<{ id?: string }>(children)
    ? React.cloneElement(children, { id: children.props.id ?? id })
    : children

  return (
    <div data-slot="field" className={cn('grid gap-1.5', className)} {...props}>
      <Label htmlFor={id}>{label}</Label>
      {control}
      {hint && !error ? (
        <p data-slot="field-hint" className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p
          data-slot="field-error"
          role="alert"
          className="text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
    </div>
  )
}

export { Field }
