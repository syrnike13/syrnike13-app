import { MicIcon, MicOffIcon } from '#/components/icons'

import {
  VoicePanelMicSettingsMenuContent,
  VoiceStageMicSettingsMenuContent,
} from '#/components/voice/voice-stage-mic-settings-menu'
import {
  VoiceSplitControl,
  type VoiceSplitControlSurface,
} from '#/components/voice/voice-split-control'
import { useVoiceMedia } from '#/features/voice/voice-media-context'
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
  const voiceMedia = useVoiceMedia()
  const { disabled, title } = microphoneMediaControlState({
    availability: voiceMedia.mediaAvailability.microphone,
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
