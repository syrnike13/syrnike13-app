import { PlusCircleIcon } from '#/components/icons'
import { cn } from '#/lib/utils'

type UserProfileStatusBubbleProps = {
  status?: string | null
  /** Own profile: the bubble edits the status and shows `placeholder` when empty. */
  onClick?: () => void
  placeholder?: string
  className?: string
}

/**
 * Облачко кастомного статуса рядом с аватаром: два «хвостовых» пузырька,
 * ведущие от аватара к облаку с текстом. Цвет — поверхность карточки.
 */
export function UserProfileStatusBubble({
  status,
  onClick,
  placeholder,
  className,
}: UserProfileStatusBubbleProps) {
  const text = status?.trim()
  if (!text && !(onClick && placeholder)) return null

  const body = text ? (
    <p className="line-clamp-2">{text}</p>
  ) : (
    <span className="flex items-center gap-1.5 text-muted-foreground">
      <PlusCircleIcon aria-hidden className="size-4 shrink-0" />
      {placeholder}
    </span>
  )

  return (
    <div
      className={cn(
        'z-20 select-none',
        !className?.includes('static') && 'absolute',
        !onClick && 'pointer-events-none',
        className,
      )}
    >
      <span
        aria-hidden
        className="absolute -top-3 -left-1 size-2.5 rounded-full bg-(--profile-surface) shadow-sm"
      />
      <span
        aria-hidden
        className="absolute -top-1.5 left-0.5 size-4 rounded-full bg-(--profile-surface) shadow-sm"
      />
      {onClick ? (
        // eslint-disable-next-line design/no-lookalike -- speech bubble around the status text
        <button
          type="button"
          className="relative w-max max-w-45 rounded-2xl bg-(--profile-surface) px-3 py-2 text-left text-sm leading-4.5 text-foreground shadow-md transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&:hover_span]:text-foreground"
          onClick={(event) => {
            event.stopPropagation()
            onClick()
          }}
        >
          {body}
        </button>
      ) : (
        <div className="relative w-max max-w-45 rounded-2xl bg-(--profile-surface) px-3 py-2 text-sm leading-4.5 text-foreground shadow-md">
          {body}
        </div>
      )}
    </div>
  )
}
