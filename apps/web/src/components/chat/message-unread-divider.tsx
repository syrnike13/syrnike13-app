type MessageUnreadDividerProps = {
  label: string
}

/** Красная линия «Новые сообщения» перед первым непрочитанным. */
export function MessageUnreadDivider({ label }: MessageUnreadDividerProps) {
  return (
    <div
      className="relative mx-3.5 flex items-center gap-2 py-2"
      role="separator"
      aria-label={label}
    >
      <div className="h-px flex-1 bg-destructive" />
      <span className="shrink-0 text-xs font-semibold text-destructive">
        {label}
      </span>
      <div className="h-px flex-1 bg-destructive" />
    </div>
  )
}
