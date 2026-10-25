import { useTranslations } from '@syrnike13/ui/i18n'
import type { ReactNode } from 'react'
import {
  ChevronDownIcon,
  ExternalLinkIcon,
  HeadphoneOffIcon,
  HeadphonesIcon,
  LogOutIcon,
  Maximize2Icon,
  MessageSquareIcon,
  MicIcon,
  MicOffIcon,
  Minimize2Icon,
  MonitorUpIcon,
  MonitorXIcon,
  MoreHorizontalIcon,
  PhoneOffIcon,
  VideoIcon,
  VideoOffIcon,
} from '#/components/icons'

import { FloatingBarShell } from '#/components/layout/floating-bar-shell'
import { Button } from '@syrnike13/ui/primitives/button'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@syrnike13/ui/primitives/dropdown-menu'
import {
  SplitButton,
  SplitButtonChevron,
  SplitButtonMain,
} from '@syrnike13/ui/primitives/split-button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@syrnike13/ui/primitives/tooltip'
import { useVoiceMedia } from '#/features/voice/voice-media-context'
import { useVoiceSession } from '#/features/voice/voice-session-context'
import { useVoiceStage } from '#/features/voice/voice-stage-context'
import { voiceMediaControlState } from '#/features/voice/voice-media-availability'
import { isMicVisuallyMuted } from '#/features/voice/voice-mic-status'
import {
  CameraDevicePickerAnchor,
  VoiceCameraSplitControl,
} from '#/components/voice/voice-camera-split-control'
import { VoiceMicSplitControl } from '#/components/voice/voice-mic-split-control'
import { VoiceStreamSettingsMenuContent } from '#/components/voice/voice-screen-share-quality'
import { VoiceSplitControl } from '#/components/voice/voice-split-control'
import {
  voiceStageViewSessionExitLabel,
  type VoiceStageViewSession,
} from '#/features/voice/voice-stage-view-session'

type VoiceStageControlsProps = {
  channelId: string
  inCall: boolean
  connecting: boolean
  joinLabel?: string
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

export function VoiceStagePopoutButton({
  active,
  disabled,
  onClick,
}: {
  active?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  const t = useTranslations('voice')

  return (
    <TooltipProvider delay={300}>
      <StageButton
        title={t('actions.stageInWindow')}
        pressed={active}
        disabled={disabled}
        onClick={onClick}
      >
        <ExternalLinkIcon />
      </StageButton>
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
  const t = useTranslations('voice')

  return (
    <TooltipProvider delay={300}>
      <StageButton
        title={active ? t('actions.exitFullscreen') : t('actions.enterFullscreen')}
        disabled={disabled}
        onClick={onClick}
      >
        {active ? <Minimize2Icon /> : <Maximize2Icon />}
      </StageButton>
    </TooltipProvider>
  )
}

/**
 * Call controls of the voice stage: an overlay bar on desktop, a floating bar
 * in the mobile drawer. Before joining it shows the join (and decline) button.
 */
export function VoiceStageControls({
  channelId,
  inCall,
  connecting,
  joinLabel,
  mobileDrawer = false,
  chatOpen = false,
  onToggleChat,
  incomingCall = false,
  declineLabel,
  onDeclineIncomingCall,
  viewSessions = EMPTY_VIEW_SESSIONS,
  focusedStageItemId = null,
  onExitViewSession = ignoreViewSessionExit,
}: VoiceStageControlsProps) {
  const t = useTranslations('voice')
  const resolvedJoinLabel = joinLabel ?? t('actions.connectVoice')
  const resolvedDeclineLabel = declineLabel ?? t('actions.cancel')
  const voiceSession = useVoiceSession()
  const voiceMedia = useVoiceMedia()
  const micMuted = isMicVisuallyMuted({
    inVoiceSession: inCall || connecting,
    micEnabled: voiceSession.micEnabled,
    micPublishing: voiceSession.micPublishing,
    deafened: voiceSession.deafened,
  })
  // A camera whose device failed keeps its "on" intent: the button turns it off,
  // and the picker under it is how the user retries with another device.
  const cameraOn = voiceMedia.cameraEnabled || voiceMedia.cameraDeviceFailed
  const sharingScreen = voiceMedia.screenShareEnabled
  const screenShareStarting = voiceMedia.screenShareStarting
  const state: ControlBarStateProps = {
    connecting,
    inCall,
    micMuted,
    soundOff: voiceSession.deafened,
    cameraOn,
    sharingScreen,
    screenShareStarting,
    cameraControl: voiceMediaControlState({
      availability: voiceMedia.mediaAvailability.camera,
      active: cameraOn,
      connecting,
      activeTitle: t('actions.stopCamera'),
      inactiveTitle: t('actions.startCamera'),
    }),
    screenShareControl: voiceMediaControlState({
      availability: voiceMedia.mediaAvailability.screenShare,
      active: sharingScreen,
      connecting,
      busy: screenShareStarting,
      activeTitle: t('actions.stopScreenShare'),
      inactiveTitle: t('actions.startScreenShare'),
      busyTitle: t('actions.screenShareStarting'),
    }),
    onToggleMic: voiceSession.toggleMic,
    onToggleDeafen: voiceSession.toggleDeafen,
    onToggleCamera: voiceMedia.toggleCamera,
    onToggleScreenShare: voiceMedia.toggleScreenShare,
    onLeave: voiceSession.leave,
    viewSessions,
    focusedStageItemId,
    onExitViewSession,
  }
  const join = () => void voiceSession.join(channelId)

  if (mobileDrawer) {
    return (
      <VoiceStageMobileDrawerControlBar
        {...state}
        joinLabel={resolvedJoinLabel}
        chatOpen={chatOpen}
        onToggleChat={onToggleChat}
        incomingCall={incomingCall}
        declineLabel={resolvedDeclineLabel}
        onDeclineIncomingCall={onDeclineIncomingCall}
        onJoin={join}
      />
    )
  }

  if (!inCall && !connecting) {
    return (
      <div className="flex items-center gap-3">
        {incomingCall && onDeclineIncomingCall ? (
          <Button
            type="button"
            size="lg"
            variant="outline"
            shape="circle"
            onClick={onDeclineIncomingCall}
          >
            <PhoneOffIcon />
            {resolvedDeclineLabel}
          </Button>
        ) : null}
        <Button type="button" size="lg" shape="circle" onClick={join}>
          {resolvedJoinLabel}
        </Button>
      </div>
    )
  }

  return <VoiceStageOverlayControlBar {...state} />
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

/** A group of call controls: the stage colour with a hairline border. */
function StageControlGroup({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-1 rounded-xl border border-on-media/10 bg-media-backdrop p-1.5">
      {children}
    </div>
  )
}

/** Icon button on the stage with a tooltip; `pressed` gives it a fill. */
function StageButton({
  title,
  danger,
  pressed,
  disabled,
  wide = false,
  shape,
  onClick,
  children,
}: {
  title: string
  danger?: boolean
  pressed?: boolean
  disabled?: boolean
  wide?: boolean
  shape?: 'circle'
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant={danger ? 'destructive' : 'media'}
            size={wide ? 'icon-wide' : 'icon-lg'}
            shape={shape}
            aria-label={title}
            aria-pressed={pressed}
            aria-disabled={disabled || undefined}
            onClick={disabled ? undefined : onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8}>
        {title}
      </TooltipContent>
    </Tooltip>
  )
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
  joinLabel?: string
  chatOpen?: boolean
  onToggleChat?: () => void
  incomingCall?: boolean
  declineLabel?: string
  onDeclineIncomingCall?: () => void
  onJoin: () => void
}) {
  const t = useTranslations('voice')
  const micTitle = micMuted ? t('media.enableMic') : t('media.disableMic')
  const chatButton = onToggleChat ? (
    <StageButton
      title={chatOpen ? t('actions.hideChat') : t('actions.openChat')}
      pressed={chatOpen}
      shape="circle"
      onClick={onToggleChat}
    >
      <MessageSquareIcon />
    </StageButton>
  ) : null

  return (
    <TooltipProvider delay={300}>
      <FloatingBarShell surfaceClassName="flex w-full min-w-0 items-center gap-2 p-2">
        {!inCall && !connecting ? (
          <>
            <StageButton
              title={micTitle}
              danger={micMuted}
              shape="circle"
              onClick={onToggleMic}
            >
              {micMuted ? <MicOffIcon /> : <MicIcon />}
            </StageButton>
            {incomingCall && onDeclineIncomingCall ? (
              <Button
                type="button"
                variant="outline"
                size="lg"
                shape="circle"
                onClick={onDeclineIncomingCall}
              >
                <PhoneOffIcon />
                {declineLabel}
              </Button>
            ) : null}
            <Button
              type="button"
              size="lg"
              shape="circle"
              className="min-w-0 flex-1"
              onClick={onJoin}
            >
              {joinLabel}
            </Button>
          </>
        ) : (
          <div className="flex min-w-0 flex-1 items-center justify-between gap-1">
            <StageButton
              title={micTitle}
              danger={micMuted}
              disabled={connecting}
              shape="circle"
              onClick={onToggleMic}
            >
              {micMuted ? <MicOffIcon /> : <MicIcon />}
            </StageButton>
            <CameraDevicePickerAnchor className="flex">
              <StageButton
                title={cameraControl.title}
                pressed={cameraOn}
                disabled={cameraControl.disabled}
                shape="circle"
                onClick={onToggleCamera}
              >
                {cameraOn ? <VideoIcon /> : <VideoOffIcon />}
              </StageButton>
            </CameraDevicePickerAnchor>
            <StageButton
              title={screenShareControl.title}
              pressed={sharingScreen || screenShareStarting}
              disabled={screenShareControl.disabled}
              shape="circle"
              onClick={onToggleScreenShare}
            >
              {screenShareStarting ? (
                <Spinner />
              ) : sharingScreen ? (
                <MonitorXIcon />
              ) : (
                <MonitorUpIcon />
              )}
            </StageButton>
            <StageButton
              title={soundOff ? t('actions.enableSound') : t('actions.disableSound')}
              danger={soundOff}
              disabled={connecting}
              shape="circle"
              onClick={onToggleDeafen}
            >
              {soundOff ? <HeadphoneOffIcon /> : <HeadphonesIcon />}
            </StageButton>
            <StageViewSettings />
            <VoiceStageExitControl
              disabled={connecting}
              sessions={viewSessions}
              focusedStageItemId={focusedStageItemId}
              onExitSession={onExitViewSession}
              onLeaveVoice={onLeave}
            />
          </div>
        )}
        {chatButton}
      </FloatingBarShell>
    </TooltipProvider>
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
  const t = useTranslations('voice')

  return (
    <TooltipProvider delay={300}>
      <div className="flex items-center gap-2">
        <StageControlGroup>
          <VoiceMicSplitControl
            surface="stage"
            inVoice={inCall}
            connecting={connecting}
            micMuted={micMuted}
            onToggleMic={onToggleMic}
          />
          <VoiceCameraSplitControl
            surface="stage"
            title={cameraControl.title}
            disabled={cameraControl.disabled}
            cameraOn={cameraOn}
            onToggleCamera={onToggleCamera}
          />
        </StageControlGroup>

        <StageControlGroup>
          <VoiceSplitControl
            surface="stage"
            success={sharingScreen || screenShareStarting}
            disabled={screenShareControl.disabled}
            mainTitle={screenShareControl.title}
            chevronTitle={t('actions.streamSettings')}
            onMainClick={onToggleScreenShare}
            popoverContent={<VoiceStreamSettingsMenuContent />}
          >
            {screenShareStarting ? (
              <Spinner className="size-5" />
            ) : sharingScreen ? (
              <MonitorXIcon className="size-5" />
            ) : (
              <MonitorUpIcon className="size-5" />
            )}
          </VoiceSplitControl>
          <StageButton
            title={soundOff ? t('actions.enableSound') : t('actions.disableSound')}
            danger={soundOff}
            disabled={connecting}
            wide
            onClick={onToggleDeafen}
          >
            {soundOff ? <HeadphoneOffIcon /> : <HeadphonesIcon />}
          </StageButton>
          <StageViewSettings wide />
        </StageControlGroup>

        <VoiceStageExitControl
          size="xl"
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

/**
 * Solid red leave control. With open views (a watched stream, an activity)
 * a chevron lists them; when a view is focused the button leaves that view.
 */
function VoiceStageExitControl({
  size = 'lg',
  disabled,
  sessions,
  focusedStageItemId,
  onExitSession,
  onLeaveVoice,
}: {
  /** xl: the height of a control group on the desktop bar. */
  size?: 'lg' | 'xl'
  disabled: boolean
  sessions: readonly VoiceStageViewSession[]
  focusedStageItemId: string | null
  onExitSession: (session: VoiceStageViewSession) => void
  onLeaveVoice: () => void
}) {
  const t = useTranslations('voice')
  const focusedSession = sessions.find(
    (session) => session.stageItemId === focusedStageItemId,
  )
  const hasMenu = sessions.length > 0 && !focusedSession
  const title = focusedSession
    ? voiceStageViewSessionExitLabel(focusedSession, t)
    : t('disconnect')
  const exitKind = focusedSession?.kind ?? 'voice'

  return (
    <SplitButton size={size} variant="danger">
      <Tooltip>
        <TooltipTrigger
          render={
            <SplitButtonMain
              aria-label={title}
              aria-disabled={disabled || undefined}
              onClick={
                disabled
                  ? undefined
                  : () =>
                      focusedSession ? onExitSession(focusedSession) : onLeaveVoice()
              }
            />
          }
        >
          <span className="inline-flex" data-voice-stage-exit-icon={exitKind} aria-hidden>
            {exitKind === 'stream' ? (
              <MonitorXIcon />
            ) : exitKind === 'activity' ? (
              <LogOutIcon />
            ) : (
              <PhoneOffIcon />
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8}>
          {title}
        </TooltipContent>
      </Tooltip>
      {hasMenu ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SplitButtonChevron
                aria-label={t('actions.chooseEndAction')}
                aria-disabled={disabled || undefined}
              />
            }
          >
            <ChevronDownIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" sideOffset={8} className="w-72">
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t('actions.activeViews')}</DropdownMenuLabel>
              {sessions.map((session) => (
                <DropdownMenuItem key={session.id} onClick={() => onExitSession(session)}>
                  <span
                    className="inline-flex"
                    data-voice-stage-exit-icon={session.kind}
                    aria-hidden
                  >
                    {session.kind === 'activity' ? <LogOutIcon /> : <MonitorXIcon />}
                  </span>
                  <span className="min-w-0 truncate">
                    {voiceStageViewSessionExitLabel(session, t)}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </SplitButton>
  )
}

/** «…» menu: which media the stage shows. */
function StageViewSettings({ wide = false }: { wide?: boolean }) {
  const t = useTranslations('voice')
  const voiceStage = useVoiceStage()
  const filters = voiceStage.stageMediaFilters
  const title = t('actions.sceneSettings')
  const toggle = (key: keyof typeof filters) => (checked: boolean) =>
    voiceStage.setStageMediaFilters((current) => ({ ...current, [key]: checked }))

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="media"
                  size={wide ? 'icon-wide' : 'icon-lg'}
                  shape={wide ? undefined : 'circle'}
                  aria-label={title}
                />
              }
            />
          }
        >
          <MoreHorizontalIcon />
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8}>
          {title}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="top" align="center" sideOffset={8} className="w-64">
        <DropdownMenuCheckboxItem
          checked={filters.showOwnStream}
          onCheckedChange={toggle('showOwnStream')}
        >
          {t('actions.showMyStream')}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={filters.showRemoteStreams}
          onCheckedChange={toggle('showRemoteStreams')}
        >
          {t('actions.showOtherStreams')}
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={filters.showParticipantsWithoutMedia}
          onCheckedChange={toggle('showParticipantsWithoutMedia')}
        >
          {t('actions.showParticipantsWithoutVideo')}
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
