import type { ReactNode } from 'react'
import {
  ChevronDownIcon,
  ExternalLinkIcon,
  HeadphoneOffIcon,
  HeadphonesIcon,
  Loader2Icon,
  Maximize2Icon,
  MessageSquareIcon,
  MicIcon,
  MicOffIcon,
  Minimize2Icon,
  MonitorUpIcon,
  MonitorXIcon,
  MoreHorizontalIcon,
  PhoneOffIcon,
  Settings2Icon,
  VideoIcon,
  VideoOffIcon,
} from '#/components/icons'

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
import { useVoiceMedia } from '#/features/voice/voice-media-context'
import { useVoiceSession } from '#/features/voice/voice-session-context'
import { useVoiceStage } from '#/features/voice/voice-stage-context'
import {
  microphoneMediaControlState,
  voiceMediaControlState,
} from '#/features/voice/voice-media-availability'
import { isMicVisuallyMuted } from '#/features/voice/voice-mic-status'
import { VoiceControlTooltip } from '#/components/voice/voice-control-tooltip'
import { VoiceMicSplitControl } from '#/components/voice/voice-mic-split-control'
import { voiceStagePopoverSettingsClass } from '#/components/voice/voice-stage-popover-styles'
import { cn } from '#/lib/utils'

type VoiceStageControlsProps = {
  channelId: string
  inCall: boolean
  connecting: boolean
  joinLabel?: string
  compact?: boolean
  /** Без внешней обёртки — позиционирование задаёт родитель (оверлей стейджа). */
  overlay?: boolean
  /** Компактная однострочная панель для мобильного drawer. */
  mobileDrawer?: boolean
  chatOpen?: boolean
  onToggleChat?: () => void
  incomingCall?: boolean
  declineLabel?: string
  onDeclineIncomingCall?: () => void
}

const stageControlGroupClass =
  'flex items-center gap-0.5 rounded-lg border border-white/10 bg-[#1e1f22] p-1.5'

const stageControlIconClass =
  'flex h-9 min-w-12 shrink-0 items-center justify-center px-2 text-white/80 transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-50'

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
  'flex h-9 w-7 shrink-0 items-center justify-center rounded-r-md rounded-l-none text-white/80 transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-50'

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
        <TooltipContent side="top" sideOffset={8}>
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
        <TooltipContent side="top" sideOffset={8}>
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
  joinLabel = 'Подключиться к голосу',
  compact = false,
  overlay = false,
  mobileDrawer = false,
  chatOpen = false,
  onToggleChat,
  incomingCall = false,
  declineLabel = 'Отменить',
  onDeclineIncomingCall,
}: VoiceStageControlsProps) {
  const voiceSession = useVoiceSession()
  const voiceMedia = useVoiceMedia()
  const micMuted = isMicVisuallyMuted({
    inVoiceSession: inCall || connecting,
    micEnabled: voiceSession.micEnabled,
    micPublishing: voiceSession.micPublishing,
  })
  const soundOff = voiceSession.deafened
  const cameraOn = voiceMedia.cameraEnabled
  const sharingScreen = voiceMedia.screenShareEnabled
  const screenShareStarting = voiceMedia.screenShareStarting
  const cameraControl = voiceMediaControlState({
    availability: voiceMedia.mediaAvailability.camera,
    active: cameraOn,
    connecting,
    activeTitle: 'Выключить камеру',
    inactiveTitle: 'Включить камеру',
  })
  const screenShareControl = voiceMediaControlState({
    availability: voiceMedia.mediaAvailability.screenShare,
    active: sharingScreen,
    connecting,
    busy: screenShareStarting,
    activeTitle: 'Остановить демонстрацию',
    inactiveTitle: 'Демонстрация экрана',
    busyTitle: 'Демонстрация запускается',
  })

  if (mobileDrawer) {
    return (
      <VoiceStageMobileDrawerControlBar
        channelId={channelId}
        connecting={connecting}
        inCall={inCall}
        joinLabel={joinLabel}
        micMuted={micMuted}
        soundOff={soundOff}
        cameraOn={cameraOn}
        sharingScreen={sharingScreen}
        screenShareStarting={screenShareStarting}
        cameraControl={cameraControl}
        screenShareControl={screenShareControl}
        chatOpen={chatOpen}
        onToggleChat={onToggleChat}
        incomingCall={incomingCall}
        declineLabel={declineLabel}
        onDeclineIncomingCall={onDeclineIncomingCall}
        onToggleMic={voiceSession.toggleMic}
        onToggleDeafen={voiceSession.toggleDeafen}
        onToggleCamera={voiceMedia.toggleCamera}
        onToggleScreenShare={voiceMedia.toggleScreenShare}
        onLeave={voiceSession.leave}
        onJoin={() => void voiceSession.join(channelId)}
      />
    )
  }

  const controlBar = overlay ? (
    <VoiceStageOverlayControlBar
      connecting={connecting}
      inCall={inCall}
      micMuted={micMuted}
      soundOff={soundOff}
      cameraOn={cameraOn}
      sharingScreen={sharingScreen}
      screenShareStarting={screenShareStarting}
      cameraControl={cameraControl}
      screenShareControl={screenShareControl}
      onToggleMic={voiceSession.toggleMic}
      onToggleDeafen={voiceSession.toggleDeafen}
      onToggleCamera={voiceMedia.toggleCamera}
      onToggleScreenShare={voiceMedia.toggleScreenShare}
      onLeave={voiceSession.leave}
    />
  ) : (
    <LegacyControlBar
      compact={compact}
      connecting={connecting}
      inCall={inCall}
      micMuted={micMuted}
      soundOff={soundOff}
      cameraOn={cameraOn}
      sharingScreen={sharingScreen}
      screenShareStarting={screenShareStarting}
      cameraControl={cameraControl}
      screenShareControl={screenShareControl}
      onToggleMic={voiceSession.toggleMic}
      onToggleDeafen={voiceSession.toggleDeafen}
      onToggleCamera={voiceMedia.toggleCamera}
      onToggleScreenShare={voiceMedia.toggleScreenShare}
      onLeave={voiceSession.leave}
    />
  )

  if (!inCall && !connecting) {
    const joinButton = (
      <Button
        type="button"
        size="lg"
        className="rounded-full px-8"
        onClick={() => void voiceSession.join(channelId)}
      >
        {joinLabel}
      </Button>
    )
    const idleControls =
      incomingCall && onDeclineIncomingCall ? (
        <div className="flex items-center gap-3">
          <Button
            type="button"
            size="lg"
            variant="outline"
            className="rounded-full border-white/20 bg-transparent px-6 text-white hover:bg-white/10"
            onClick={onDeclineIncomingCall}
          >
            <PhoneOffIcon className="size-4" />
            {declineLabel}
          </Button>
          {joinButton}
        </div>
      ) : (
        joinButton
      )

    if (overlay) return idleControls

    return (
      <div className="flex justify-center px-4 pb-8 pt-2">{idleControls}</div>
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

type MediaControlState = {
  title: string
  disabled: boolean
}

type ControlBarStateProps = {
  inCall: boolean
  connecting: boolean
  micMuted: boolean
  soundOff: boolean
  cameraOn: boolean
  sharingScreen: boolean
  screenShareStarting: boolean
  cameraControl: MediaControlState
  screenShareControl: MediaControlState
  onToggleMic: () => void
  onToggleDeafen: () => void
  onToggleCamera: () => void
  onToggleScreenShare: () => void
  onLeave: () => void
}

function VoiceStageMobileDrawerControlBar({
  connecting,
  inCall,
  joinLabel,
  micMuted,
  soundOff,
  cameraOn,
  sharingScreen,
  screenShareStarting,
  cameraControl,
  screenShareControl,
  chatOpen,
  onToggleChat,
  incomingCall,
  declineLabel,
  onDeclineIncomingCall,
  onToggleMic,
  onToggleDeafen,
  onToggleCamera,
  onToggleScreenShare,
  onLeave,
  onJoin,
}: ControlBarStateProps & {
  channelId: string
  joinLabel?: string
  chatOpen?: boolean
  onToggleChat?: () => void
  incomingCall?: boolean
  declineLabel?: string
  onDeclineIncomingCall?: () => void
  onJoin: () => void
}) {
  const barClass =
    'flex w-full min-w-0 items-center gap-2 rounded-2xl bg-[#111214]/95 p-2 shadow-lg ring-1 ring-white/10'
  const sideButtonClass =
    'flex size-11 shrink-0 items-center justify-center rounded-full bg-[#2b2d31] text-white transition-colors hover:bg-[#35373c] disabled:opacity-50'

  if (!inCall && !connecting) {
    const joinButton = (
      <Button
        type="button"
        className="h-11 min-w-0 flex-1 rounded-full bg-[#23a559] px-4 text-sm font-semibold text-white hover:bg-[#1a9d4f]"
        onClick={onJoin}
      >
        {joinLabel}
      </Button>
    )

    return (
      <div className={barClass}>
        <button
          type="button"
          title={micMuted ? 'Включить микрофон' : 'Выключить микрофон'}
          aria-label={micMuted ? 'Включить микрофон' : 'Выключить микрофон'}
          className={cn(
            sideButtonClass,
            micMuted && 'bg-[#ed4245]/20 text-[#ff6b6b]',
          )}
          onClick={onToggleMic}
        >
          {micMuted ? (
            <MicOffIcon className="size-5" />
          ) : (
            <MicIcon className="size-5" />
          )}
        </button>
        {incomingCall && onDeclineIncomingCall ? (
          <>
            <Button
              type="button"
              variant="outline"
              className="h-11 shrink-0 rounded-full border-white/20 bg-transparent px-4 text-white hover:bg-white/10"
              onClick={onDeclineIncomingCall}
            >
              <PhoneOffIcon className="size-4" />
              {declineLabel}
            </Button>
            {joinButton}
          </>
        ) : (
          joinButton
        )}
        {onToggleChat ? (
          <button
            type="button"
            title={chatOpen ? 'Скрыть чат' : 'Открыть чат'}
            aria-label={chatOpen ? 'Скрыть чат' : 'Открыть чат'}
            aria-pressed={chatOpen}
            className={cn(sideButtonClass, chatOpen && 'bg-white/15')}
            onClick={onToggleChat}
          >
            <MessageSquareIcon className="size-5" />
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className={barClass}>
        <div className="flex min-w-0 flex-1 items-center justify-between gap-1">
          <MobileDrawerIconButton
            title={micMuted ? 'Включить микрофон' : 'Выключить микрофон'}
            danger={micMuted}
            disabled={connecting}
            onClick={onToggleMic}
          >
            {micMuted ? (
              <MicOffIcon className="size-5" />
            ) : (
              <MicIcon className="size-5" />
            )}
          </MobileDrawerIconButton>
          <MobileDrawerIconButton
            title={cameraControl.title}
            success={cameraOn}
            disabled={cameraControl.disabled}
            onClick={onToggleCamera}
          >
            {cameraOn ? (
              <VideoIcon className="size-5" />
            ) : (
              <VideoOffIcon className="size-5" />
            )}
          </MobileDrawerIconButton>
          <MobileDrawerIconButton
            title={screenShareControl.title}
            highlight={sharingScreen || screenShareStarting}
            disabled={screenShareControl.disabled}
            onClick={onToggleScreenShare}
          >
            {screenShareStarting ? (
              <Loader2Icon className="size-5 animate-spin" />
            ) : sharingScreen ? (
              <MonitorXIcon className="size-5" />
            ) : (
              <MonitorUpIcon className="size-5" />
            )}
          </MobileDrawerIconButton>
          <MobileDrawerIconButton
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
          </MobileDrawerIconButton>
          <StageViewSettings compact overlay trigger="more" />
          <button
            type="button"
            title="Отключиться"
            disabled={connecting}
            onClick={onLeave}
            className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[#ed4245] text-white transition-colors hover:bg-[#d84040] disabled:opacity-50"
          >
            <PhoneOffIcon className="size-5" />
          </button>
        </div>
        {onToggleChat ? (
          <button
            type="button"
            title={chatOpen ? 'Скрыть чат' : 'Открыть чат'}
            aria-label={chatOpen ? 'Скрыть чат' : 'Открыть чат'}
            aria-pressed={chatOpen}
            className={cn(sideButtonClass, chatOpen && 'bg-white/15')}
            onClick={onToggleChat}
          >
            <MessageSquareIcon className="size-5" />
          </button>
        ) : null}
      </div>
    </TooltipProvider>
  )
}

function MobileDrawerIconButton({
  title,
  danger,
  success,
  highlight,
  disabled,
  onClick,
  children,
}: {
  title: string
  danger?: boolean
  success?: boolean
  highlight?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <VoiceControlTooltip title={title}>
      <button
        type="button"
        aria-disabled={disabled}
        onClick={disabled ? undefined : onClick}
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-full text-white/85 transition-colors',
          danger && 'bg-[#ed4245]/20 text-[#ff6b6b]',
          success && 'bg-[#23a559]/20 text-[#4ade80]',
          highlight && !danger && !success && 'bg-white/15 text-white',
          !danger && !success && !highlight && 'bg-[#2b2d31] hover:bg-[#35373c]',
          disabled && 'opacity-50',
        )}
      >
        {children}
      </button>
    </VoiceControlTooltip>
  )
}

function VoiceStageOverlayControlBar({
  connecting,
  inCall,
  micMuted,
  soundOff,
  cameraOn,
  sharingScreen,
  screenShareStarting,
  cameraControl,
  screenShareControl,
  onToggleMic,
  onToggleDeafen,
  onToggleCamera,
  onToggleScreenShare,
  onLeave,
}: ControlBarStateProps) {
  return (
    <TooltipProvider delayDuration={300}>
    <div className="flex items-stretch gap-2">
      <div className={stageControlGroupClass}>
        <VoiceMicSplitControl
          surface="stage"
          inVoice={inCall}
          connecting={connecting}
          micMuted={micMuted}
          onToggleMic={onToggleMic}
        />

        <StageControlDivider />

        <StageMediaControl
          title={cameraControl.title}
          success={cameraOn}
          disabled={cameraControl.disabled}
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
          title={screenShareControl.title}
          highlight={sharingScreen || screenShareStarting}
          disabled={screenShareControl.disabled}
          onClick={onToggleScreenShare}
        >
          {screenShareStarting ? (
            <Loader2Icon className="size-5 animate-spin" />
          ) : sharingScreen ? (
            <MonitorXIcon className="size-5" />
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
    </TooltipProvider>
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

  const mainDisabled = Boolean(disabled)

  return (
    <div className="group/media flex items-center gap-px">
      <VoiceControlTooltip title={title}>
        <button
          type="button"
          aria-disabled={mainDisabled}
          onClick={mainDisabled ? undefined : onClick}
          className={stageMediaSegmentButtonClass('main', segmentState)}
        >
          {children}
        </button>
      </VoiceControlTooltip>
      {chevron ?? (
        <VoiceControlTooltip title="Параметры камеры">
          <button
            type="button"
            aria-disabled={mainDisabled || chevronDisabled}
            className={stageMediaSegmentButtonClass('chevron', segmentState)}
          >
            <ChevronDownIcon className="size-3.5" />
          </button>
        </VoiceControlTooltip>
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
  const isDisabled = Boolean(disabled)

  return (
    <VoiceControlTooltip title={title}>
      <button
        type="button"
        aria-disabled={isDisabled}
        onClick={isDisabled ? undefined : onClick}
        className={stageIconButtonClass({ danger, highlight })}
      >
        {children}
      </button>
    </VoiceControlTooltip>
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
  cameraControl,
  screenShareControl,
  onToggleMic,
  onToggleDeafen,
  onToggleCamera,
  onToggleScreenShare,
  onLeave,
}: ControlBarStateProps & { compact: boolean }) {
  const voiceMedia = useVoiceMedia()
  const micControl = microphoneMediaControlState({
    availability: voiceMedia.mediaAvailability.microphone,
    inVoice: inCall,
    micMuted,
    connecting,
  })

  return (
    <TooltipProvider delayDuration={300}>
    <div
      className={cn(
        'flex items-center gap-1 rounded-full bg-[#232428] p-1.5 shadow-lg ring-1 ring-white/10',
        compact && 'p-0.5',
      )}
    >
      <LegacyControlButton
        title={micControl.title}
        active={micMuted}
        disabled={micControl.disabled}
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
        title={cameraControl.title}
        active={!cameraOn}
        disabled={cameraControl.disabled}
        compact={compact}
        onClick={onToggleCamera}
      >
        {cameraOn ? <VideoIcon className="size-5" /> : <VideoOffIcon className="size-5" />}
      </LegacyControlButton>

      <LegacyControlButton
        title={screenShareControl.title}
        active={sharingScreen || screenShareStarting}
        disabled={screenShareControl.disabled}
        compact={compact}
        onClick={onToggleScreenShare}
      >
        {screenShareStarting ? (
          <Loader2Icon className="size-5 animate-spin" />
        ) : sharingScreen ? (
          <MonitorXIcon className="size-5" />
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
    </TooltipProvider>
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
  const voiceStage = useVoiceStage()
  const filters = voiceStage.stageMediaFilters
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
            voiceStage.setStageMediaFilters((current) => ({
              ...current,
              showOwnStream: checked,
            }))
          }
        />
        <StageFilterToggle
          checked={filters.showRemoteStreams}
          label="Показывать чужие стримы"
          onChange={(checked) =>
            voiceStage.setStageMediaFilters((current) => ({
              ...current,
              showRemoteStreams: checked,
            }))
          }
        />
        <StageFilterToggle
          checked={filters.showParticipantsWithoutMedia}
          label="Показывать участников без видео"
          onChange={(checked) =>
            voiceStage.setStageMediaFilters((current) => ({
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
  const isDisabled = Boolean(disabled)

  return (
    <VoiceControlTooltip title={title}>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-disabled={isDisabled}
        onClick={isDisabled ? undefined : onClick}
        className={cn(
          'rounded-full text-foreground hover:bg-white/10 aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
          compact ? 'size-8' : 'size-11',
          active && 'bg-white/10 text-destructive',
        )}
      >
        {children}
      </Button>
    </VoiceControlTooltip>
  )
}
