import type { ReactNode } from 'react'
import {
  HeadphoneOffIcon,
  HeadphonesIcon,
  MicIcon,
  MicOffIcon,
  MonitorUpIcon,
  PhoneOffIcon,
  Settings2Icon,
  VideoIcon,
  VideoOffIcon,
} from 'lucide-react'

import { Button } from '#/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import { useVoice } from '#/features/voice/voice-provider'
import { isMicVisuallyMuted, micControlTitle } from '#/features/voice/voice-mic-status'
import { cn } from '#/lib/utils'

type VoiceStageControlsProps = {
  channelId: string
  inCall: boolean
  connecting: boolean
  compact?: boolean
  /** Без внешней обёртки — позиционирование задаёт родитель (оверлей стейджа). */
  overlay?: boolean
}

export function VoiceStageControls({
  channelId,
  inCall,
  connecting,
  compact = false,
  overlay = false,
}: VoiceStageControlsProps) {
  const voice = useVoice()
  const micMuted = isMicVisuallyMuted({
    inVoiceSession: inCall || connecting,
    micEnabled: voice.micEnabled,
    micPublishing: voice.micPublishing,
  })
  const soundOff = voice.deafened
  const cameraOn = voice.cameraEnabled
  const sharingScreen = voice.screenShareEnabled

  const controlBar = (
    <div
      className={cn(
        'flex items-center gap-1 rounded-full bg-[#232428] shadow-lg ring-1 ring-white/10',
        compact ? 'p-0.5' : 'p-1.5',
      )}
    >
        <ControlButton
          title={micControlTitle({
            inVoice: inCall,
            micMuted,
            micIssue: voice.micIssue,
          })}
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

        <StageViewSettings compact={compact} />

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
  )

  if (!inCall && !connecting) {
    const joinButton = (
      <Button
        type="button"
        size="lg"
        className="rounded-full px-8"
        onClick={() => void voice.join(channelId)}
      >
        Подключиться к голосу
      </Button>
    )

    if (overlay) return joinButton

    return (
      <div className="flex justify-center px-4 pb-8 pt-2">{joinButton}</div>
    )
  }

  if (overlay) return controlBar

  return (
    <div
      className={cn(
        'flex justify-center',
        compact ? 'px-1 py-0' : 'px-4 pb-8 pt-2',
      )}
    >
      {controlBar}
    </div>
  )
}

function StageViewSettings({ compact }: { compact: boolean }) {
  const voice = useVoice()
  const filters = voice.stageMediaFilters

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          title="Настройки сцены"
          className={cn(
            'rounded-full text-foreground hover:bg-white/10',
            compact ? 'size-8' : 'size-11',
          )}
        >
          <Settings2Icon className="size-5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="center"
        data-voice-stage-popover
        className="z-[420] w-72 border-white/10 bg-[#2b2d31] p-2 text-sm text-white"
      >
        <StageFilterToggle
          checked={filters.showOwnStream}
          label="Показывать мой стрим"
          onChange={(checked) =>
            voice.setStageMediaFilters((current) => ({
              ...current,
              showOwnStream: checked,
            }))
          }
        />
        <StageFilterToggle
          checked={filters.showRemoteStreams}
          label="Показывать чужие стримы"
          onChange={(checked) =>
            voice.setStageMediaFilters((current) => ({
              ...current,
              showRemoteStreams: checked,
            }))
          }
        />
        <StageFilterToggle
          checked={filters.showParticipantsWithoutMedia}
          label="Показывать участников без видео"
          onChange={(checked) =>
            voice.setStageMediaFilters((current) => ({
              ...current,
              showParticipantsWithoutMedia: checked,
            }))
          }
        />
      </PopoverContent>
    </Popover>
  )
}

function StageFilterToggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean
  label: string
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded px-2 py-2 hover:bg-white/10">
      <input
        type="checkbox"
        className="size-4 accent-primary"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
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
