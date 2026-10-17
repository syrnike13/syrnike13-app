import { ExternalLinkIcon } from '#/components/icons'
import { useTranslations } from '@syrnike13/ui/i18n'

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
  const t = useTranslations('voice')

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-media-backdrop p-6 text-center text-on-media">
      <ExternalLinkIcon className="size-8 text-on-media/50" aria-hidden />
      <div className="space-y-1">
        <p className="text-sm font-medium">{t('stage.popoutTitle')}</p>
        <p className="text-xs text-on-media/60">{title}</p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={onFocusPopout}>
          {t('stage.goToWindow')}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onReturn}>
          {t('stage.returnHere')}
        </Button>
      </div>
    </div>
  )
}
