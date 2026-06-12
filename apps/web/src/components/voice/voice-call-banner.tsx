import { HeadphonesIcon, PhoneOffIcon } from '#/components/icons'
import { Button } from '#/components/ui/button'

type VoiceCallBannerProps = {
  title: string
  detail: string
  actionLabel: string
  dismissLabel: string
  onJoin: () => void
  onDismiss: () => void
}

export function VoiceCallBanner({
  title,
  detail,
  actionLabel,
  dismissLabel,
  onJoin,
  onDismiss,
}: VoiceCallBannerProps) {
  return (
    <div className="shrink-0 border-b border-shell-divider bg-[#1e1f22]/95 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#23a559]/15 text-[#23a559]">
          <HeadphonesIcon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">
            {title}
          </p>
          <p className="truncate text-xs text-muted-foreground">{detail}</p>
        </div>
        <Button
          type="button"
          size="sm"
          className="h-8 shrink-0 bg-[#23a559] text-white hover:bg-[#1f944f]"
          onClick={onJoin}
        >
          <HeadphonesIcon className="size-4" />
          {actionLabel}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={onDismiss}
        >
          <PhoneOffIcon className="size-4" />
          {dismissLabel}
        </Button>
      </div>
    </div>
  )
}
