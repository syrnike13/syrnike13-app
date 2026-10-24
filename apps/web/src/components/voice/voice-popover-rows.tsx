import type { ReactNode } from 'react'

import {
  Item,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemTitle,
} from '@syrnike13/ui/primitives/item'
import { RadioGroupItem } from '@syrnike13/ui/primitives/radio-group'
import { cn } from '#/lib/utils'

/**
 * Rows of the voice popovers (mic, camera, stream quality): composed from
 * `Item`, so they share hover, focus and spacing with other menus.
 */
export function VoicePopoverRow({
  label,
  icon,
  trailing,
  destructive = false,
  disabled,
  onClick,
}: {
  label: string
  icon?: ReactNode
  trailing?: ReactNode
  destructive?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <Item
      size="xs"
      className={destructive ? 'text-destructive' : undefined}
      render={<button type="button" disabled={disabled} />}
      onClick={onClick}
    >
      {icon ? <ItemMedia variant="icon">{icon}</ItemMedia> : null}
      <ItemContent>
        <ItemTitle>{label}</ItemTitle>
      </ItemContent>
      {trailing ? (
        <ItemActions className="text-muted-foreground">{trailing}</ItemActions>
      ) : null}
    </Item>
  )
}

/** A radio option row; wrap rows in a `RadioGroup`. */
export function VoicePopoverRadioRow({
  value,
  label,
}: {
  value: string
  label: string
}) {
  return (
    <Item size="xs" render={<label />}>
      <ItemContent>
        <ItemTitle className="w-full truncate">{label}</ItemTitle>
      </ItemContent>
      <ItemActions>
        <RadioGroupItem value={value} aria-label={label} />
      </ItemActions>
    </Item>
  )
}

export function VoicePopoverTitle({ children }: { children: ReactNode }) {
  return <p className="px-2.5 text-xs font-semibold text-foreground">{children}</p>
}

export function VoicePopoverHint({
  tone = 'default',
  children,
}: {
  tone?: 'default' | 'destructive'
  children: ReactNode
}) {
  return (
    <p
      className={cn(
        'px-2.5 text-xs',
        tone === 'destructive' ? 'text-destructive' : 'text-muted-foreground',
      )}
    >
      {children}
    </p>
  )
}
