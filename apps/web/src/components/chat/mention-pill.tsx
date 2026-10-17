import {
  defaultMentionClassName,
  mentionColourValues,
} from '#/lib/mention-styles'
import type { CSSVars } from '#/lib/css-vars'
import { cn } from '#/lib/utils'

export { defaultMentionClassName, mentionColourValues }

export function MentionPill({
  label,
  nameColour,
  className,
}: {
  label: string
  nameColour?: string
  className?: string
}) {
  const colours = mentionColourValues(nameColour)
  const colourStyle = colours
    ? ({
        '--mention-bg': colours.background,
        '--mention-bg-hover': colours.backgroundHover,
      } as CSSVars)
    : undefined

  return (
    <span
      style={colourStyle}
      className={cn(
        'inline rounded-sm px-0.5 font-medium transition-colors',
        !nameColour && defaultMentionClassName,
        nameColour &&
          'bg-(--mention-bg) text-primary-foreground hover:bg-(--mention-bg-hover)',
        className,
      )}
    >
      {label}
    </span>
  )
}
