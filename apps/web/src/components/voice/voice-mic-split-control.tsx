import { MicIcon, MicOffIcon } from '#/components/icons'

import {
  VoicePanelMicSettingsMenuContent,
  VoiceStageMicSettingsMenuContent,
} from '#/components/voice/voice-stage-mic-settings-menu'
import {
  VoiceSplitControl,
  type VoiceSplitControlSurface,
} from '#/components/voice/voice-split-control'
import { useVoice } from '#/features/voice/voice-context'
import { microphoneMediaControlState } from '#/features/voice/voice-media-availability'

export function VoiceMicSplitControl({
  surface,
  inVoice,
  connecting,
  micMuted,
  onToggleMic,
}: {
  surface: VoiceSplitControlSurface
  inVoice: boolean
  connecting: boolean
  micMuted: boolean
  onToggleMic: () => void
}) {
  const voice = useVoice()
  const { disabled, title } = microphoneMediaControlState({
    availability: voice.mediaAvailability.microphone,
    inVoice,
    micMuted,
    connecting,
  })

  return (
    <VoiceSplitControl
      surface={surface}
      danger={micMuted}
      disabled={disabled}
      mainTitle={title}
      chevronTitle="Параметры микрофона"
      onMainClick={onToggleMic}
      popoverContent={
        surface === 'panel' ? (
          <VoicePanelMicSettingsMenuContent />
        ) : (
          <VoiceStageMicSettingsMenuContent />
        )
      }
    >
      {micMuted ? (
        <MicOffIcon className="size-5" />
      ) : (
        <MicIcon className="size-5" />
      )}
    </VoiceSplitControl>
  )
}
