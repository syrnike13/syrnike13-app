import { cn } from '#/lib/utils'

type UserProfileStatusBubbleProps = {
  status?: string | null
  className?: string
}

/**
 * Облачко кастомного статуса рядом с аватаром (как в Discord):
 * два «хвостовых» пузырька, ведущие от аватара к облаку с текстом.
 */
export function UserProfileStatusBubble({
  status,
  className,
}: UserProfileStatusBubbleProps) {
  const text = status?.trim()
  if (!text) return null

  return (
    <div
      className={cn(
        'pointer-events-none z-20 select-none ',
        !className?.includes('static') && 'absolute',
        className,
      )}
    >
      <span
        aria-hidden
        className="gradient-surface-solid absolute -top-3.5 -left-0.5 size-2.5 rounded-full bg-popover shadow-background shadow-sm"
      />
      <span
        aria-hidden
        className="gradient-surface-solid absolute -top-1.5 left-1.5 size-5 rounded-full bg-popover shadow-sm"
      />
      <div className="gradient-surface-solid relative w-max max-w-[200px] rounded-2xl bg-popover px-3 py-1.5 text-sm leading-snug text-popover-foreground shadow-md">
        <p className="line-clamp-2">{text}</p>
      </div>
    </div>
  )
}
