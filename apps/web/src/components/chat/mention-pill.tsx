import {
  defaultMentionClassName,
  mentionColourStyle,
} from '#/lib/mention-styles'
import { cn } from '#/lib/utils'

export { defaultMentionClassName, mentionColourStyle }

export function MentionPill({
  label,
  nameColour,
  className,
}: {
  label: string
  nameColour?: string
  className?: string
}) {
  const colourStyle = mentionColourStyle(nameColour)

  return (
    <span
      style={colourStyle}
      className={cn(
        'inline rounded-sm px-0.5 font-medium transition-colors',
        !nameColour && defaultMentionClassName,
        nameColour && 'hover:[background-color:var(--mention-bg-hover)]',
        className,
      )}
    >
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
    <span className={cn(defaultMentionClassName, className)}>{label}</span>
  )
}
