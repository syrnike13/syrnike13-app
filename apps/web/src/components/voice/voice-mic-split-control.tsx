import { MicIcon, MicOffIcon } from 'lucide-react'

import {
  VoicePanelMicSettingsMenuContent,
  VoiceStageMicSettingsMenuContent,
} from '#/components/voice/voice-stage-mic-settings-menu'
import {
  VoiceSplitControl,
  type VoiceSplitControlSurface,
} from '#/components/voice/voice-split-control'
import { micControlTitle } from '#/features/voice/voice-mic-status'

export function VoiceMicSplitControl({
  surface,
  inVoice,
  connecting,
  micMuted,
  micIssue,
  onToggleMic,
}: {
  surface: VoiceSplitControlSurface
  inVoice: boolean
  connecting: boolean
  micMuted: boolean
  micIssue: { label: string } | null | undefined
  onToggleMic: () => void
}) {
  return (
    <VoiceSplitControl
      surface={surface}
      danger={micMuted}
      disabled={connecting}
      mainTitle={micControlTitle({
        inVoice,
        micMuted,
        micIssue,
      })}
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
