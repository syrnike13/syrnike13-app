import type { ReactNode } from 'react'
import {
  HeadphoneOffIcon,
  HeadphonesIcon,
  MicIcon,
  MicOffIcon,
  MonitorUpIcon,
  PhoneOffIcon,
  VideoIcon,
  VideoOffIcon,
} from 'lucide-react'

import { Button } from '#/components/ui/button'
import { useVoice } from '#/features/voice/voice-provider'
import { cn } from '#/lib/utils'

type VoiceStageControlsProps = {
  channelId: string
  inCall: boolean
  connecting: boolean
  compact?: boolean
}

export function VoiceStageControls({
  channelId,
  inCall,
  connecting,
  compact = false,
}: VoiceStageControlsProps) {
  const voice = useVoice()
  const micMuted = !voice.micEnabled
  const soundOff = voice.deafened
  const cameraOn = voice.cameraEnabled
  const sharingScreen = voice.screenShareEnabled

  if (!inCall && !connecting) {
    return (
      <div className="flex justify-center px-4 pb-8 pt-2">
        <Button
          type="button"
          size="lg"
          className="rounded-full px-8"
          onClick={() => void voice.join(channelId)}
        >
          Подключиться к голосу
        </Button>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'flex justify-center',
        compact ? 'px-1 py-0' : 'px-4 pb-8 pt-2',
      )}
    >
      <div
        className={cn(
          'flex items-center gap-1 rounded-full bg-[#232428] shadow-lg ring-1 ring-white/10',
          compact ? 'p-0.5' : 'p-1.5',
        )}
      >
        <ControlButton
          title={
            micMuted ? 'Включить микрофон' : 'Выключить микрофон'
          }
          active={micMuted}
          disabled={connecting}
          compact={compact}
          onClick={voice.toggleMic}
        >
          {micMuted ? (
            <MicOffIcon className="size-5" />
          ) : (
            <MicIcon className="size-5" />
          )}
        </ControlButton>

        <ControlButton
          title={soundOff ? 'Включить звук' : 'Отключить звук'}
          active={soundOff}
          disabled={connecting}
          compact={compact}
          onClick={voice.toggleDeafen}
        >
          {soundOff ? (
            <HeadphoneOffIcon className="size-5" />
          ) : (
            <HeadphonesIcon className="size-5" />
          )}
        </ControlButton>

        <ControlButton
          title={cameraOn ? 'Выключить камеру' : 'Включить камеру'}
          active={!cameraOn}
          disabled={connecting}
          compact={compact}
          onClick={voice.toggleCamera}
        >
          {cameraOn ? (
            <VideoIcon className="size-5" />
          ) : (
            <VideoOffIcon className="size-5" />
          )}
        </ControlButton>

        <ControlButton
          title={
            sharingScreen ? 'Остановить демонстрацию' : 'Демонстрация экрана'
          }
          active={sharingScreen}
          disabled={connecting}
          compact={compact}
          onClick={voice.toggleScreenShare}
        >
          <MonitorUpIcon className="size-5" />
        </ControlButton>

        <Button
          type="button"
          size="icon"
          variant="ghost"
          className={cn(
            'rounded-full bg-[#ed4245] text-white hover:bg-[#c03537] hover:text-white',
            compact ? 'size-8' : 'size-11',
          )}
          title="Отключиться"
          disabled={connecting}
          onClick={voice.leave}
        >
          <PhoneOffIcon className="size-5" />
        </Button>
      </div>
    </div>
  )
}

function ControlButton({
  title,
  active,
  disabled,
  compact,
  onClick,
  children,
}: {
  title: string
  active?: boolean
  disabled?: boolean
  compact?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded-full text-foreground hover:bg-white/10',
        compact ? 'size-8' : 'size-11',
        active && 'bg-white/10 text-destructive',
      )}
    >
      {children}
    </Button>
  )
}
