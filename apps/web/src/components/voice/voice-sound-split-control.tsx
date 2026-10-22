import { HeadphoneOffIcon, HeadphonesIcon } from '#/components/icons'
import { useTranslations } from '@syrnike13/ui/i18n'

import { VoiceSoundSettingsMenuContent } from '#/components/voice/voice-stage-mic-settings-menu'
import {
  VoiceSplitControl,
  type VoiceSplitControlSurface,
} from '#/components/voice/voice-split-control'

export function VoiceSoundSplitControl({
  surface,
  connecting,
  soundOff,
  onToggleDeafen,
}: {
  surface: VoiceSplitControlSurface
  inVoice: boolean
  connecting: boolean
  soundOff: boolean
  onToggleDeafen: () => void
}) {
  const t = useTranslations('voice')

  return (
    <VoiceSplitControl
      surface={surface}
      danger={soundOff}
      disabled={connecting}
      mainTitle={
        soundOff ? t('actions.enableSound') : t('actions.disableSound')
      }
      chevronTitle={t('actions.soundSettings')}
      onMainClick={onToggleDeafen}
      popoverContent={<VoiceSoundSettingsMenuContent />}
    >
      {soundOff ? (
        <HeadphoneOffIcon className="size-5" />
      ) : (
        <HeadphonesIcon className="size-5" />
      )}
    </VoiceSplitControl>
  )
}
