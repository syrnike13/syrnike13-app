import { HeadphoneOffIcon, HeadphonesIcon } from '#/components/icons'

import { VoiceSoundSettingsMenuContent } from '#/components/voice/voice-stage-mic-settings-menu'
import {
  VoiceSplitControl,
  type VoiceSplitControlSurface,
} from '#/components/voice/voice-split-control'

function soundControlTitle({
  soundOff,
}: {
  soundOff: boolean
}) {
  return soundOff ? 'Включить звук' : 'Выключить звук'
}

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
  return (
    <VoiceSplitControl
      surface={surface}
      danger={soundOff}
      disabled={connecting}
      mainTitle={soundControlTitle({ soundOff })}
      chevronTitle="Параметры звука"
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
