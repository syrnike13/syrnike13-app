type MessageDateDividerProps = {
  label: string
}

export function MessageDateDivider({ label }: MessageDateDividerProps) {
  return (
    <div
      className="relative flex items-center py-3"
      role="separator"
      aria-label={label}
    >
      <div className="h-px flex-1 bg-border" />
      <time
        dateTime={label}
        className="mx-3 shrink-0 rounded px-2 text-[11px] font-semibold text-muted-foreground"
      >
        {label}
      </time>
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}
