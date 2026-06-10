import type { ReactNode } from 'react'
import {
  ChevronDownIcon,
  ExternalLinkIcon,
  HeadphoneOffIcon,
  HeadphonesIcon,
  Loader2Icon,
  Maximize2Icon,
  MicIcon,
  MicOffIcon,
  Minimize2Icon,
  MonitorUpIcon,
  MoreHorizontalIcon,
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '#/components/ui/tooltip'
import { useVoice } from '#/features/voice/voice-context'
import { isMicVisuallyMuted, micControlTitle } from '#/features/voice/voice-mic-status'
import { VoiceMicSplitControl } from '#/components/voice/voice-mic-split-control'
import { voiceStagePopoverSettingsClass } from '#/components/voice/voice-stage-popover-styles'
import { cn } from '#/lib/utils'

type VoiceStageControlsProps = {
  channelId: string
  inCall: boolean
  connecting: boolean
  compact?: boolean
  /** Без внешней обёртки — позиционирование задаёт родитель (оверлей стейджа). */
  overlay?: boolean
}

const stageControlGroupClass =
  'flex items-center gap-0.5 rounded-lg border border-white/10 bg-[#1e1f22] p-1.5'

const stageControlIconClass =
  'flex h-9 min-w-12 shrink-0 items-center justify-center px-2 text-white/80 transition-colors disabled:pointer-events-none disabled:opacity-50'

const stageControlNeutralMainGroupHoverClass =
  'group-hover/media:bg-white/10 group-hover/media:text-white'

const stageControlNeutralChevronGroupHoverClass =
  'group-hover/media:bg-white/[0.06] group-hover/media:text-white'

/** Мьют: яркая красная иконка, полупрозрачный красный фон. */
const stageControlDangerMainClass =
  'bg-[#ed4245]/20 text-[#ff5c5c] group-hover/media:bg-[#ed4245]/30 group-hover/media:text-[#ff6b6b]'

const stageControlDangerChevronClass =
  'bg-[#ed4245]/20 text-[#ff5c5c] group-hover/media:bg-[#ed4245]/12 group-hover/media:text-[#ff6b6b]'

/** Камера включена. */
const stageControlSuccessMainClass =
  'bg-[#23a559]/20 text-[#3dd16f] group-hover/media:bg-[#23a559]/30 group-hover/media:text-[#4ade80]'

const stageControlSuccessChevronClass =
  'bg-[#23a559]/20 text-[#3dd16f] group-hover/media:bg-[#23a559]/12 group-hover/media:text-[#4ade80]'

const stageControlHighlightClass =
  'bg-white/15 text-white hover:bg-white/20'

/** Отдельные кнопки в средней группе (не split media). */
const stageControlDangerStandaloneClass =
  'bg-[#ed4245]/20 text-[#ff5c5c] hover:bg-[#ed4245]/30 hover:text-[#ff6b6b]'

function stageIconButtonClass({
  danger,
  highlight,
}: {
  danger?: boolean
  highlight?: boolean
}) {
  return cn(
    stageControlIconClass,
    'rounded-md',
    danger && stageControlDangerStandaloneClass,
    highlight && !danger && stageControlHighlightClass,
    !danger && !highlight && 'text-white/80 hover:bg-white/10 hover:text-white',
  )
}

const stageControlMediaMainClass = 'rounded-l-md rounded-r-none'

const stageControlChevronClass =
  'flex h-9 w-7 shrink-0 items-center justify-center rounded-r-md rounded-l-none text-white/80 transition-colors disabled:pointer-events-none disabled:opacity-50'

function stageMediaSegmentButtonClass(
  segment: 'main' | 'chevron',
  {
    danger,
    success,
    chevronDisabled,
  }: {
    danger?: boolean
    success?: boolean
    chevronDisabled?: boolean
  },
) {
  const isChevron = segment === 'chevron'

  return cn(
    isChevron
      ? stageControlChevronClass
      : cn(stageControlIconClass, stageControlMediaMainClass),
    danger && (isChevron ? stageControlDangerChevronClass : stageControlDangerMainClass),
    success &&
      (isChevron ? stageControlSuccessChevronClass : stageControlSuccessMainClass),
    !danger &&
      !success &&
      (isChevron
        ? stageControlNeutralChevronGroupHoverClass
        : stageControlNeutralMainGroupHoverClass),
    isChevron && chevronDisabled && !danger && !success && 'opacity-40',
  )
}

export function VoiceStagePopoutButton({
  active,
  disabled,
  onClick,
}: {
  active?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              'inline-flex self-center',
              disabled && 'cursor-not-allowed',
            )}
          >
            <button
              type="button"
              disabled={disabled}
              onClick={onClick}
              className={cn(
                'flex size-9 shrink-0 items-center justify-center transition-colors disabled:pointer-events-none disabled:opacity-40',
                active ? 'text-white' : 'text-white/60 hover:text-white',
              )}
            >
              <ExternalLinkIcon className="size-5" />
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8} className="z-[430]">
          Стейдж в отдельном окне
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function VoiceStageFullscreenButton({
  active,
  disabled,
  onClick,
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
}) {
  const label = active ? 'Выйти из fullscreen' : 'На весь экран'

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              'inline-flex self-center',
              disabled && 'cursor-not-allowed',
            )}
          >
            <button
              type="button"
              disabled={disabled}
              onClick={onClick}
              className="flex size-9 shrink-0 items-center justify-center text-white/60 transition-colors hover:text-white disabled:pointer-events-none disabled:opacity-40"
            >
              {active ? (
                <Minimize2Icon className="size-5" />
              ) : (
                <Maximize2Icon className="size-5" />
              )}
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8} className="z-[430]">
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
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
  const screenShareStarting = voice.screenShareStarting

  const controlBar = overlay ? (
    <VoiceStageOverlayControlBar
      channelId={channelId}
      connecting={connecting}
      inCall={inCall}
      micMuted={micMuted}
      soundOff={soundOff}
      cameraOn={cameraOn}
      sharingScreen={sharingScreen}
      screenShareStarting={screenShareStarting}
      micIssue={voice.micIssue}
      onToggleMic={voice.toggleMic}
      onToggleDeafen={voice.toggleDeafen}
      onToggleCamera={voice.toggleCamera}
      onToggleScreenShare={voice.toggleScreenShare}
      onLeave={voice.leave}
    />
  ) : (
    <LegacyControlBar
      channelId={channelId}
      compact={compact}
      connecting={connecting}
      inCall={inCall}
      micMuted={micMuted}
      soundOff={soundOff}
      cameraOn={cameraOn}
      sharingScreen={sharingScreen}
      screenShareStarting={screenShareStarting}
      micIssue={voice.micIssue}
      onToggleMic={voice.toggleMic}
      onToggleDeafen={voice.toggleDeafen}
      onToggleCamera={voice.toggleCamera}
      onToggleScreenShare={voice.toggleScreenShare}
      onLeave={voice.leave}
    />
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

type ControlBarStateProps = {
  channelId: string
  inCall: boolean
  connecting: boolean
  micMuted: boolean
  soundOff: boolean
  cameraOn: boolean
  sharingScreen: boolean
  screenShareStarting: boolean
  micIssue: { label: string } | null | undefined
  onToggleMic: () => void
  onToggleDeafen: () => void
  onToggleCamera: () => void
  onToggleScreenShare: () => void
  onLeave: () => void
}

function VoiceStageOverlayControlBar({
  connecting,
  inCall,
  micMuted,
  soundOff,
  cameraOn,
  sharingScreen,
  screenShareStarting,
  micIssue,
  onToggleMic,
  onToggleDeafen,
  onToggleCamera,
  onToggleScreenShare,
  onLeave,
}: Omit<ControlBarStateProps, 'channelId'>) {
  return (
    <div className="flex items-stretch gap-2">
      <div className={stageControlGroupClass}>
        <VoiceMicSplitControl
          surface="stage"
          inVoice={inCall}
          connecting={connecting}
          micMuted={micMuted}
          micIssue={micIssue}
          onToggleMic={onToggleMic}
        />

        <StageControlDivider />

        <StageMediaControl
          title={cameraOn ? 'Выключить камеру' : 'Включить камеру'}
          success={cameraOn}
          disabled={connecting}
          onClick={onToggleCamera}
          chevronDisabled
        >
          {cameraOn ? (
            <VideoIcon className="size-5" />
          ) : (
            <VideoOffIcon className="size-5" />
          )}
        </StageMediaControl>
      </div>

      <div className={stageControlGroupClass}>
        <StageIconButton
          title={
            screenShareStarting
              ? 'Демонстрация запускается'
              : sharingScreen
                ? 'Остановить демонстрацию'
                : 'Демонстрация экрана'
          }
          highlight={sharingScreen || screenShareStarting}
          disabled={connecting || screenShareStarting}
          onClick={onToggleScreenShare}
        >
          {screenShareStarting ? (
            <Loader2Icon className="size-5 animate-spin" />
          ) : (
            <MonitorUpIcon className="size-5" />
          )}
        </StageIconButton>

        <StageIconButton
          title={soundOff ? 'Включить звук' : 'Отключить звук'}
          danger={soundOff}
          disabled={connecting}
          onClick={onToggleDeafen}
        >
          {soundOff ? (
            <HeadphoneOffIcon className="size-5" />
          ) : (
            <HeadphonesIcon className="size-5" />
          )}
        </StageIconButton>

        <StageViewSettings overlay trigger="more" />
      </div>

      <button
        type="button"
        title="Отключиться"
        disabled={connecting}
        onClick={onLeave}
        className="flex min-w-[3.75rem] shrink-0 items-center justify-center rounded-lg bg-[#ed4245] px-3 text-white transition-colors hover:bg-[#d84040] disabled:opacity-50"
      >
        <PhoneOffIcon className="size-5" />
      </button>
    </div>
  )
}

function StageMediaControl({
  title,
  danger,
  success,
  disabled,
  onClick,
  chevron,
  chevronDisabled,
  children,
}: {
  title: string
  danger?: boolean
  success?: boolean
  disabled?: boolean
  onClick: () => void
  chevron?: ReactNode
  chevronDisabled?: boolean
  children: ReactNode
}) {
  const segmentState = { danger, success, chevronDisabled }

  return (
    <div className="group/media flex items-center gap-px">
      <button
        type="button"
        title={title}
        disabled={disabled}
        onClick={onClick}
        className={stageMediaSegmentButtonClass('main', segmentState)}
      >
        {children}
      </button>
      {chevron ?? (
        <button
          type="button"
          title="Параметры камеры"
          disabled={disabled || chevronDisabled}
          className={stageMediaSegmentButtonClass('chevron', segmentState)}
        >
          <ChevronDownIcon className="size-3.5" />
        </button>
      )}
    </div>
  )
}

function StageControlDivider() {
  return <div className="mx-0.5 h-6 w-px shrink-0 bg-white/10" aria-hidden />
}

function StageIconButton({
  title,
  danger,
  highlight,
  disabled,
  onClick,
  children,
}: {
  title: string
  danger?: boolean
  highlight?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={stageIconButtonClass({ danger, highlight })}
    >
      {children}
    </button>
  )
}

function LegacyControlBar({
  compact,
  connecting,
  inCall,
  micMuted,
  soundOff,
  cameraOn,
  sharingScreen,
  screenShareStarting,
  micIssue,
  onToggleMic,
  onToggleDeafen,
  onToggleCamera,
  onToggleScreenShare,
  onLeave,
}: Omit<ControlBarStateProps, 'channelId'> & { compact: boolean }) {
  return (
    <div
      className={cn(
        'flex items-center gap-1 rounded-full bg-[#232428] p-1.5 shadow-lg ring-1 ring-white/10',
        compact && 'p-0.5',
      )}
    >
      <LegacyControlButton
        title={micControlTitle({ inVoice: inCall, micMuted, micIssue })}
        active={micMuted}
        disabled={connecting}
        compact={compact}
        onClick={onToggleMic}
      >
        {micMuted ? <MicOffIcon className="size-5" /> : <MicIcon className="size-5" />}
      </LegacyControlButton>

      <LegacyControlButton
        title={soundOff ? 'Включить звук' : 'Отключить звук'}
        active={soundOff}
        disabled={connecting}
        compact={compact}
        onClick={onToggleDeafen}
      >
        {soundOff ? (
          <HeadphoneOffIcon className="size-5" />
        ) : (
          <HeadphonesIcon className="size-5" />
        )}
      </LegacyControlButton>

      <LegacyControlButton
        title={cameraOn ? 'Выключить камеру' : 'Включить камеру'}
        active={!cameraOn}
        disabled={connecting}
        compact={compact}
        onClick={onToggleCamera}
      >
        {cameraOn ? <VideoIcon className="size-5" /> : <VideoOffIcon className="size-5" />}
      </LegacyControlButton>

      <LegacyControlButton
        title={
          screenShareStarting
            ? 'Демонстрация запускается'
            : sharingScreen
              ? 'Остановить демонстрацию'
              : 'Демонстрация экрана'
        }
        active={sharingScreen || screenShareStarting}
        disabled={connecting || screenShareStarting}
        compact={compact}
        onClick={onToggleScreenShare}
      >
        {screenShareStarting ? (
          <Loader2Icon className="size-5 animate-spin" />
        ) : (
          <MonitorUpIcon className="size-5" />
        )}
      </LegacyControlButton>

      <StageViewSettings compact={compact} trigger="settings" />

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
        onClick={onLeave}
      >
        <PhoneOffIcon className="size-5" />
      </Button>
    </div>
  )
}

function StageViewSettings({
  compact = false,
  overlay = false,
  trigger = 'more',
}: {
  compact?: boolean
  overlay?: boolean
  /** overlay: «…» как в Discord; legacy: шестерёнка */
  trigger?: 'settings' | 'more'
}) {
  const voice = useVoice()
  const filters = voice.stageMediaFilters
  const resolvedTrigger = overlay ? 'more' : trigger

  const icon =
    resolvedTrigger === 'more' ? (
      <MoreHorizontalIcon className="size-5" />
    ) : (
      <Settings2Icon className="size-5" />
    )

  const title = overlay
    ? 'Настройки сцены'
    : trigger === 'more'
      ? 'Ещё'
      : 'Настройки сцены'

  return (
    <Popover>
      <PopoverTrigger asChild>
        {overlay ? (
          <button
            type="button"
            title={title}
            className={stageIconButtonClass({})}
          >
            {icon}
          </button>
        ) : (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            title={title}
            className={cn(
              'rounded-full text-foreground hover:bg-white/10',
              compact ? 'size-8' : 'size-11',
            )}
          >
            {icon}
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="center"
        data-voice-stage-popover
        className={voiceStagePopoverSettingsClass}
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
    <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-accent/70">
      <input
        type="checkbox"
        className="size-4 rounded border-input accent-primary"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  )
}

function LegacyControlButton({
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
