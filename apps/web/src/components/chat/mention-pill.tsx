import {
  defaultMentionClassName,
  mentionColourStyle,
} from '#/lib/mention-styles'
import { cn } from '#/lib/utils'

export { defaultMentionClassName, mentionColourStyle }

export function MentionPill({
  label,
  nameColour,
  prefix = '@',
  className,
}: {
  label: string
  nameColour?: string
  prefix?: '@' | '#' | ''
  className?: string
}) {
  const colourStyle = mentionColourStyle(nameColour)

  return (
    <span
      style={colourStyle}
      className={cn(
        'inline rounded-sm px-0.5 font-medium',
        !nameColour && defaultMentionClassName,
        className,
      )}
    >
      {prefix}
      {label}
    </span>
  )
}

export function MassMentionPill({
  label,
  className,
}: {
  label: string
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline rounded-sm bg-primary/15 px-0.5 font-medium text-primary',
        className,
      )}
    >
      {label}
    </span>
  )
}
