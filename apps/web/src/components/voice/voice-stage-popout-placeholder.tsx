import { ExternalLinkIcon } from '#/components/icons'

import { Button } from '#/components/ui/button'

type VoiceStagePopoutPlaceholderProps = {
  title: string
  onReturn: () => void
  onFocusPopout: () => void
}

export function VoiceStagePopoutPlaceholder({
  title,
  onReturn,
  onFocusPopout,
}: VoiceStagePopoutPlaceholderProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-black p-6 text-center text-white">
      <ExternalLinkIcon className="size-8 text-white/50" aria-hidden />
      <div className="space-y-1">
        <p className="text-sm font-medium">Голосовой стейдж в отдельном окне</p>
        <p className="text-xs text-white/60">{title}</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={onFocusPopout}>
          Перейти в окно
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onReturn}>
          Вернуть сюда
        </Button>
      </div>
    </div>
  )
}
