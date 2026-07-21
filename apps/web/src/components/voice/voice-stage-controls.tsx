import type { ReactNode } from 'react'
import { PhoneXmark } from 'iconoir-react/solid'
import {
  ChevronDownIcon,
  ExternalLinkIcon,
  HeadphoneOffIcon,
  HeadphonesIcon,
  Loader2Icon,
  LogOutIcon,
  Maximize2Icon,
  MessageSquareIcon,
  MicIcon,
  MicOffIcon,
  Minimize2Icon,
  MonitorUpIcon,
  MonitorXIcon,
  MoreHorizontalIcon,
  Settings2Icon,
  VideoIcon,
  VideoOffIcon,
} from '#/components/icons'

import { Button } from '#/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
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
import {
  splitControlDangerChevronClass,
  splitControlDangerMainClass,
  splitControlDangerStandaloneClass,
} from '#/components/voice/voice-split-control'
import { voiceStagePopoverSettingsClass } from '#/components/voice/voice-stage-popover-styles'
import {
  voiceStageViewSessionExitLabel,
  type VoiceStageViewSession,
} from '#/features/voice/voice-stage-view-session'
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
  viewSessions?: readonly VoiceStageViewSession[]
  focusedStageItemId?: string | null
  onExitViewSession?: (session: VoiceStageViewSession) => void
}

const EMPTY_VIEW_SESSIONS: readonly VoiceStageViewSession[] = []
const ignoreViewSessionExit = () => undefined

const stageControlGroupClass =
  'flex items-center gap-0.5 rounded-lg border border-white/10 bg-card p-1.5'

const stageControlIconClass =
  'flex h-9 min-w-12 shrink-0 items-center justify-center px-2 text-white/80 transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-50'

const stageControlNeutralMainGroupHoverClass =
  'group-hover/media:bg-white/10 group-hover/media:text-white'

const stageControlNeutralChevronGroupHoverClass =
  'group-hover/media:bg-white/[0.06] group-hover/media:text-white'

/** Мьют: яркая красная иконка, полупрозрачный красный фон. */
const stageControlDangerMainClass = splitControlDangerMainClass

const stageControlDangerChevronClass = splitControlDangerChevronClass

/** Камера включена. */
const stageControlSuccessMainClass =
  'bg-chart-3/20 text-chart-3 group-hover/media:bg-chart-3/30 group-hover/media:text-chart-3'

const stageControlSuccessChevronClass =
  'bg-chart-3/20 text-chart-3 group-hover/media:bg-chart-3/12 group-hover/media:text-chart-3'

const stageControlHighlightClass =
  'bg-white/15 text-white hover:bg-white/20'

/** Отдельные кнопки в средней группе (не split media). */
const stageControlDangerStandaloneClass = splitControlDangerStandaloneClass

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
  viewSessions = EMPTY_VIEW_SESSIONS,
  focusedStageItemId = null,
  onExitViewSession = ignoreViewSessionExit,
}: VoiceStageControlsProps) {
  const voiceSession = useVoiceSession()
  const voiceMedia = useVoiceMedia()
  const micMuted = isMicVisuallyMuted({
    inVoiceSession: inCall || connecting,
    micEnabled: voiceSession.micEnabled,
    micPublishing: voiceSession.micPublishing,
    deafened: voiceSession.deafened,
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
        viewSessions={viewSessions}
        focusedStageItemId={focusedStageItemId}
        onExitViewSession={onExitViewSession}
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
      viewSessions={viewSessions}
      focusedStageItemId={focusedStageItemId}
      onExitViewSession={onExitViewSession}
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
      viewSessions={viewSessions}
      focusedStageItemId={focusedStageItemId}
      onExitViewSession={onExitViewSession}
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
  viewSessions: readonly VoiceStageViewSession[]
  focusedStageItemId: string | null
  onExitViewSession: (session: VoiceStageViewSession) => void
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
  viewSessions,
  focusedStageItemId,
  onExitViewSession,
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
    'flex w-full min-w-0 items-center gap-2 rounded-2xl bg-background/95 p-2 shadow-lg ring-1 ring-white/10'
  const sideButtonClass =
    'flex size-11 shrink-0 items-center justify-center rounded-full bg-muted text-primary-foreground transition-colors hover:bg-accent disabled:opacity-50'

  if (!inCall && !connecting) {
    const joinButton = (
      <Button
        type="button"
        className="h-11 min-w-0 flex-1 rounded-full bg-chart-3 px-4 text-sm font-semibold text-primary-foreground hover:bg-chart-3/90"
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
            micMuted && 'bg-destructive/20 text-destructive',
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
            title={soundOff ? 'Включить звук' : 'Выключить звук'}
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
          <VoiceStageExitControl
            surface="mobile"
            disabled={connecting}
            sessions={viewSessions}
            focusedStageItemId={focusedStageItemId}
            onExitSession={onExitViewSession}
            onLeaveVoice={onLeave}
          />
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
          danger && 'bg-destructive/20 text-destructive',
          success && 'bg-chart-3/20 text-chart-3',
          highlight && !danger && !success && 'bg-white/15 text-white',
          !danger && !success && !highlight && 'bg-muted hover:bg-accent',
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
  viewSessions,
  focusedStageItemId,
  onExitViewSession,
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
          title={soundOff ? 'Включить звук' : 'Выключить звук'}
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

      <VoiceStageExitControl
        surface="overlay"
        disabled={connecting}
        sessions={viewSessions}
        focusedStageItemId={focusedStageItemId}
        onExitSession={onExitViewSession}
        onLeaveVoice={onLeave}
      />
    </div>
    </TooltipProvider>
  )
}

type VoiceStageExitControlProps = {
  surface: 'overlay' | 'mobile' | 'legacy'
  compact?: boolean
  disabled: boolean
  sessions: readonly VoiceStageViewSession[]
  focusedStageItemId: string | null
  onExitSession: (session: VoiceStageViewSession) => void
  onLeaveVoice: () => void
}

function VoiceStageExitControl({
  surface,
  compact = false,
  disabled,
  sessions,
  focusedStageItemId,
  onExitSession,
  onLeaveVoice,
}: VoiceStageExitControlProps) {
  const focusedSession = sessions.find(
    (session) => session.stageItemId === focusedStageItemId,
  )
  const hasMenu = sessions.length > 0 && !focusedSession
  const title = focusedSession
    ? voiceStageViewSessionExitLabel(focusedSession)
    : 'Отключиться от голоса'
  const onPrimaryAction = () => {
    if (focusedSession) {
      onExitSession(focusedSession)
      return
    }
    onLeaveVoice()
  }

  const mainButton = (
    <VoiceControlTooltip title={title}>
      <button
        type="button"
        title={title}
        aria-label={title}
        disabled={disabled}
        onClick={onPrimaryAction}
        className={cn(
          'flex shrink-0 items-center justify-center bg-destructive text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-50',
          surface === 'overlay' && 'min-w-[3.75rem] self-stretch px-3',
          surface === 'mobile' && 'h-11 min-w-11 px-3',
          surface === 'legacy' &&
            (compact ? 'h-8 min-w-8 px-2' : 'h-11 min-w-11 px-3'),
          hasMenu
            ? surface === 'overlay'
              ? 'rounded-l-lg'
              : 'rounded-l-full'
            : surface === 'overlay'
              ? 'rounded-lg'
              : 'rounded-full',
        )}
      >
        {focusedSession?.kind === 'stream' ? (
          <span
            className="inline-flex size-5 shrink-0"
            data-voice-stage-exit-icon="stream"
            aria-hidden
          >
            <MonitorXIcon className="size-5" />
          </span>
        ) : focusedSession?.kind === 'activity' ? (
          <span
            className="inline-flex size-5 shrink-0"
            data-voice-stage-exit-icon="activity"
            aria-hidden
          >
            <LogOutIcon className="size-5" />
          </span>
        ) : (
          <span
            className="inline-flex size-5 shrink-0"
            data-voice-stage-exit-icon="voice"
            aria-hidden
          >
            <PhoneXmark className="size-5" />
          </span>
        )}
      </button>
    </VoiceControlTooltip>
  )

  if (!hasMenu) return mainButton

  return (
    <DropdownMenu>
      <div className="flex shrink-0 items-stretch gap-px">
        {mainButton}
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Выбрать, что завершить"
            title="Выбрать, что завершить"
            disabled={disabled}
            className={cn(
              'flex shrink-0 items-center justify-center bg-destructive text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-50',
              surface === 'overlay' && 'w-8 self-stretch rounded-r-lg',
              surface === 'mobile' && 'h-11 w-7 rounded-r-full',
              surface === 'legacy' &&
                (compact
                  ? 'h-8 w-6 rounded-r-full'
                  : 'h-11 w-7 rounded-r-full'),
            )}
          >
            <ChevronDownIcon className="size-4" />
          </button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-72"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>Активные просмотры</DropdownMenuLabel>
          {sessions.map((session) => {
            const SessionIcon =
              session.kind === 'activity' ? LogOutIcon : MonitorXIcon
            return (
              <DropdownMenuItem
                key={session.id}
                onSelect={() => onExitSession(session)}
              >
                <span
                  className="inline-flex size-4 shrink-0"
                  data-voice-stage-exit-icon={session.kind}
                  aria-hidden
                >
                  <SessionIcon className="size-4" />
                </span>
                <span className="min-w-0 truncate">
                  {voiceStageViewSessionExitLabel(session)}
                </span>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
  viewSessions,
  focusedStageItemId,
  onExitViewSession,
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
        'flex items-center gap-1 rounded-full bg-muted p-1.5 shadow-lg ring-1 ring-white/10',
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
        title={soundOff ? 'Включить звук' : 'Выключить звук'}
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

      <VoiceStageExitControl
        surface="legacy"
        compact={compact}
        disabled={connecting}
        sessions={viewSessions}
        focusedStageItemId={focusedStageItemId}
        onExitSession={onExitViewSession}
        onLeaveVoice={onLeave}
      />
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
