import { Separator } from '@syrnike13/ui/primitives/separator'

type MessageDateDividerProps = {
  label: string
}

export function MessageDateDivider({ label }: MessageDateDividerProps) {
  return (
    <div
      className="relative mx-3.5 mt-6 mb-2 flex items-center"
      role="separator"
      aria-label={label}
    >
      <Separator aria-hidden className="flex-1" />
      <span className="mx-3 shrink-0 text-xs font-medium text-muted-foreground">
        {label}
      </span>
      <Separator aria-hidden className="flex-1" />
    </div>
  )
}
