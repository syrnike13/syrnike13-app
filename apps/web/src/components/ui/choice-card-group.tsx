import { useId, type ComponentType, type SVGProps } from 'react'

import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from '@syrnike13/ui/primitives/field'
import { RadioGroup, RadioGroupItem } from '@syrnike13/ui/primitives/radio-group'

export type ChoiceCardOption<T extends string> = {
  value: T
  label: string
  description?: string
  icon?: ComponentType<SVGProps<SVGSVGElement>>
}

/**
 * Pick one of a few options shown as cards (shadcn "choice card": a radio
 * inside a FieldLabel, which highlights the checked card).
 */
export function ChoiceCardGroup<T extends string>({
  value,
  options,
  label,
  onValueChange,
}: {
  value: T
  options: readonly ChoiceCardOption<T>[]
  /** Accessible name of the group. */
  label: string
  onValueChange: (value: T) => void
}) {
  const id = useId()

  return (
    <RadioGroup
      value={value}
      aria-label={label}
      className="grid gap-2 sm:grid-cols-2"
      onValueChange={(next) => onValueChange(next as T)}
    >
      {options.map((option) => {
        const Icon = option.icon
        const itemId = `${id}-${option.value}`
        return (
          <FieldLabel key={option.value} htmlFor={itemId}>
            <Field orientation="horizontal">
              {Icon ? (
                <Icon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
              ) : null}
              <FieldContent>
                <FieldTitle>{option.label}</FieldTitle>
                {option.description ? (
                  <FieldDescription>{option.description}</FieldDescription>
                ) : null}
              </FieldContent>
              <RadioGroupItem value={option.value} id={itemId} />
            </Field>
          </FieldLabel>
        )
      })}
    </RadioGroup>
  )
}
