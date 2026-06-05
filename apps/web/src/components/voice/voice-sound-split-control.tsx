import { HeadphoneOffIcon, HeadphonesIcon } from 'lucide-react'

import { VoiceSoundSettingsMenuContent } from '#/components/voice/voice-stage-mic-settings-menu'
import {
  VoiceSplitControl,
  type VoiceSplitControlSurface,
} from '#/components/voice/voice-split-control'

function soundControlTitle({
  inVoice,
  soundOff,
}: {
  inVoice: boolean
  soundOff: boolean
}) {
  if (inVoice) {
    return soundOff ? 'Включить звук' : 'Отключить звук'
  }

  return soundOff
    ? 'Звук выключен (применится при входе в голос)'
    : 'Отключить звук до входа в голос'
}

export function VoiceSoundSplitControl({
  surface,
  inVoice,
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
      mainTitle={soundControlTitle({ inVoice, soundOff })}
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
