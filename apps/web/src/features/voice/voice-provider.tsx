import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'
import {
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrackPublication,
  type VideoTrack,
} from 'livekit-client'
import { toast } from 'sonner'

import { useAuth } from '#/features/auth/auth-context'
import { eventsGateway } from '#/features/events/gateway'
import { resolveVoiceNodeName } from '#/features/voice/voice-node'
import {
  createVoiceJoinRunner,
  nativeCredentialsFromJoinResponse,
  type ActiveVoiceSessionSnapshot,
  type LiveKitNativeCredentials,
  type LiveKitNativeMediaKind,
  type LiveKitNativePublisherCredentials,
  type VoiceJoinRunnerDeps,
} from '#/features/voice/voice-join'
import {
  createVoiceRejoinController,
  type VoiceRejoinControllerOptions,
} from '#/features/voice/voice-rejoin'
import {
  requestVoiceCredentialsRefresh,
  requestVoiceFlagsUpdate,
  requestVoiceLeave,
} from '#/features/voice/voice-gateway'
import {
  canJoinVoiceChannel,
} from '#/features/voice/voice-api-capability'
import { syncStore } from '#/features/sync/sync-store'
import {
  createRemoteAudioMixer,
  type RemoteAudioMixer,
  type RemoteAudioSource,
} from '#/features/voice/remote-audio-mixer'
import {
  createLocalSpeakingDetector,
  type LocalSpeakingDetector,
} from '#/features/voice/local-speaking-detector'
import { mergeSpeakingUserIds } from '#/features/voice/voice-speaking-users'
import { voiceListenerStore } from '#/features/voice/voice-listener-store'
import {
  liveKitRoomParticipantIds,
  patchLocalVoiceCamera,
  patchLocalVoiceDeafen,
  patchLocalVoiceMic,
  removeLocalUserFromAllVoiceChannels,
} from '#/features/voice/voice-participant-sync'
import {
  localParticipantVoiceFlags,
  participantMicPublishing,
} from '#/features/voice/voice-participant-media'
import {
  appendVoicePingSample,
  type VoicePingSample,
} from '#/features/voice/voice-ping-history'
import { measureVoicePingMs } from '#/features/voice/voice-ping'
import {
  appendRtcDebugSample,
  collectVoiceRtcDebugSnapshot,
  deriveRtcRates,
  type RtcDebugSnapshot,
  type RtcDebugStageMediaItem,
} from '#/features/voice/voice-rtc-debug'
import {
  screenShareAudioCaptureOptions,
  screenShareCaptureOptions,
  screenShareCombinedPublishOptions,
  type ScreenShareCaptureLimits,
  voiceMicPublishOptions,
} from '#/features/voice/voice-capture'
import { tuneScreenShareAfterPublish } from '#/features/voice/voice-screen-share-tuning'
import { resolveScreenShareCaptureLimits } from '#/features/voice/voice-screen-share-limits'
import { logVoiceDebugAgent } from '#/features/voice/voice-debug-agent-log'
import { DesktopScreenSharePicker } from '#/features/voice/desktop-screen-share-picker'
import { nativeMediaEngineStatsStore } from '#/features/voice/native-media-engine-stats'
import { shouldUseNativeScreenShare } from '#/features/voice/native-screen-share-mode'
import { createVoiceOperationId } from '#/features/voice/voice-operation'
import { createVoiceSessionController } from '#/features/voice/voice-session-controller'
import {
  localVoiceSupersedeFromGatewayEvent,
  voiceCommitFromGatewayEvent,
  voiceCommitOperationIdToObserve,
} from '#/features/voice/voice-session-events'
import { decideVoiceRecoveryAction } from '#/features/voice/voice-recovery'
import {
  createInitialNativeMediaState,
  isNativeScreenPublished,
  isNativeScreenStarting,
  type NativeMediaAction,
  type NativeMediaState,
  nativeMediaReducer,
} from '#/features/voice/native-media-coordinator'
import {
  findNativeScreenPublication,
  waitForNativeScreenPublication,
} from '#/features/voice/voice-publication-observer'
import {
  publishNativeScreenShare,
  type NativeScreenShareSession,
} from '#/features/voice/native-screen-share-publish'
import {
  configureNativeMicrophoneSession,
  publishNativeMicrophone,
  shouldRestartNativeMicrophonePublisher,
  shouldUseNativeMicrophone,
  type NativeMicrophoneSession,
} from '#/features/voice/native-microphone-publish'
import {
  baseVoiceIdentity,
  isDesktopNativeVoiceIdentity,
} from '#/features/voice/native-voice-identity'
import { NativeScreenShareCoordinator } from '#/features/voice/native-screen-share-coordinator'
import {
  clearNativePickerSelection,
  rejectNativePickerSelection,
  waitForNativePickerSelection,
} from '#/features/voice/native-screen-share-session'
import { getSyrnikeDesktop } from '#/platform/runtime'
import {
  applyMicProcessing,
  refreshMicProcessing,
} from '#/features/voice/voice-mic-processing'
import { SYRNIKE_MIC_PROCESSOR_NAME } from '#/features/voice/voice-mic-processor'
import { clearSessionVoiceGateThreshold } from '#/features/voice/voice-gate-session'
import { voicePreferenceEffectFlags } from '#/features/voice/voice-preference-effects'
import {
  describeMicDeviceError,
  MIC_BLOCKED_WITHOUT_ERROR,
  shouldResetMicPreferenceOnIssue,
  type VoiceConnectionPhase,
  type VoiceMicIssue,
  type VoiceStatus,
} from '#/features/voice/voice-mic-status'
import { useMediaDevices } from '#/features/voice/use-media-devices'
import { buildVoiceMediaAvailabilityState } from '#/features/voice/voice-media-availability'
import { isVoiceConnectedInChannel } from '#/features/voice/voice-watch-screen-share'
import type { ScreenShareQualityName } from '#/features/voice/voice-preference-types'
import {
  effectiveVoiceJoinPreferences,
  readVoicePreferences,
  voicePreferenceStore,
} from '#/features/voice/voice-preference-store'
import {
  createConnectingLocalVoiceState,
  isVoiceLocalUserId,
  withConnectingLocalAvatarItem,
} from '#/features/voice/voice-connecting-preview'
import {
  buildStageMediaItems,
  type StageMediaFilters,
  type StageMediaTrackEntry,
  type StageMediaTrackSource,
  stageMediaItemId,
} from '#/features/voice/voice-stage-media'
import {
  applyStageScreenPublicationSubscription,
  pruneWatchedRemoteScreenIds,
  resolveStageScreenSubscriptionTarget,
  setRemoteScreenWatchIntent,
  setStageScreenSubscription,
  shouldSubscribeStageScreen,
  stageScreenMediaUserId,
} from '#/features/voice/voice-stage-subscription'
import {
  SCREEN_VIEWER_SOUND_TOPIC,
  createScreenViewerSoundPayload,
  screenViewerSoundEventFromData,
} from '#/features/voice/voice-screen-viewer-sounds'
import { runVoiceRequest } from '#/features/voice/voice-request-gate'
import {
  recordVoiceTransitionAttempt,
  voiceTransitionBlockedUntil,
} from '#/features/voice/voice-transition-rate-limit'
import {
  rememberCanceledVoiceOperation,
  resetLocalVoiceEventGuard,
  setLocalVoiceEventUserId,
  shouldIgnoreVoiceGatewayEvent,
} from '#/features/voice/voice-local-event-guard'
import { channelAudioBitrateKbps } from '#/lib/channel-audio-bitrate'
import { playUiSound } from '#/features/sounds/sound-player'
import {
  VoiceContext,
  type VoiceContextValue,
  type VoiceStageMediaItem,
  type VoiceStageMediaPublication,
} from '#/features/voice/voice-context'

const DEVICE_SWITCH_TIMEOUT_MS = 5_000
const VOICE_RECOVERY_HEALTH_INTERVAL_MS = 5_000
const VOICE_RECOVERY_SERVER_STATE_GRACE_MS = 10_000
const STAGE_MEDIA_FILTERS_STORAGE_KEY = 'syrnike13.voice.stageMediaFilters'
type DisconnectIntent = 'none' | 'switch' | 'leave' | 'cleanup'
type NativeScreenPublicationLossReason =
  | 'participant-disconnected'
  | 'track-unpublished'
  | 'publication-missing'
type NativeScreenPublicationLoss = {
  reason: NativeScreenPublicationLossReason
  participantIdentity: string
  publicationSid?: string
  remoteParticipants?: number
}
type NativeScreenPublicationLossHandler = (
  loss: NativeScreenPublicationLoss,
) => void
const DEFAULT_STAGE_MEDIA_FILTERS: StageMediaFilters = {
  showOwnStream: true,
  showRemoteStreams: true,
  showParticipantsWithoutMedia: true,
}

function readStageMediaFilters(): StageMediaFilters {
  if (typeof window === 'undefined') return DEFAULT_STAGE_MEDIA_FILTERS
  try {
    const raw = window.localStorage.getItem(STAGE_MEDIA_FILTERS_STORAGE_KEY)
    if (!raw) return DEFAULT_STAGE_MEDIA_FILTERS
    return {
      ...DEFAULT_STAGE_MEDIA_FILTERS,
      ...(JSON.parse(raw) as Partial<StageMediaFilters>),
    }
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('Failed to read stage media filters from localStorage', error)
    }
    return DEFAULT_STAGE_MEDIA_FILTERS
  }
}

function writeStageMediaFilters(filters: StageMediaFilters) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      STAGE_MEDIA_FILTERS_STORAGE_KEY,
      JSON.stringify(filters),
    )
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('Failed to write stage media filters to localStorage', error)
    }
    // localStorage may be unavailable in private/browser-restricted contexts.
  }
}

function stringSetEquals(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  if (left.size !== right.size) return false
  for (const value of right) {
    if (!left.has(value)) return false
  }
  return true
}

function stageMediaTrackSource(
  source: Track.Source,
): StageMediaTrackSource | null {
  if (source === Track.Source.ScreenShare) return 'screen'
  if (source === Track.Source.Camera) return 'camera'
  return null
}

function remotePublicationSid(publication: RemoteTrackPublication) {
  return publication.trackSid || publication.sid
}

function isCurrentNativeScreenParticipant(
  screen: NativeMediaState['screen'],
  participantIdentity: string,
) {
  return (
    screen.status === 'published' &&
    screen.participantIdentity === participantIdentity
  )
}

function isCurrentNativeScreenPublication(
  screen: NativeMediaState['screen'],
  participantIdentity: string,
  publication: RemoteTrackPublication,
) {
  if (!isCurrentNativeScreenParticipant(screen, participantIdentity)) {
    return false
  }
  return remotePublicationSid(publication) === screen.publicationSid
}

function hasCurrentNativeScreenPublication(
  room: Room,
  screen: NativeMediaState['screen'],
) {
  if (screen.status !== 'published') return false
  const participant = room.remoteParticipants.get(screen.participantIdentity)
  if (!participant) return false

  for (const publication of participant.trackPublications.values()) {
    if (publication.source !== Track.Source.ScreenShare) continue
    if (remotePublicationSid(publication) === screen.publicationSid) return true
  }

  return false
}

function liveKitTokenExpMs(token: string) {
  const [, payload] = token.split('.')
  if (!payload) return null
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      '=',
    )
    const parsed = JSON.parse(window.atob(padded)) as { exp?: unknown }
    return typeof parsed.exp === 'number' ? parsed.exp * 1000 : null
  } catch {
    return null
  }
}

function shouldRefreshLiveKitToken(credentials: LiveKitNativePublisherCredentials) {
  const expMs = liveKitTokenExpMs(credentials.token)
  return expMs == null || expMs - Date.now() < 60_000
}

function isLiveKitTokenFailure(error: unknown) {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return (
    message.includes('invalid token') ||
    message.includes('expired') ||
    message.includes('unauthorized') ||
    message.includes('401')
  )
}

async function switchDeviceWithTimeout(
  room: Room,
  kind: 'audioinput' | 'audiooutput',
  deviceId: string,
) {
  await Promise.race([
    room.switchActiveDevice(kind, deviceId).catch(() => {}),
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, DEVICE_SWITCH_TIMEOUT_MS)
    }),
  ])
}

type AudioTrackWithMedia = Track & {
  mediaStreamTrack?: MediaStreamTrack
  sid?: string
}

type LocalAudioTrackWithProcessor = AudioTrackWithMedia & {
  getProcessor?: () =>
    | {
        name?: string
        processedTrack?: MediaStreamTrack
      }
    | undefined
}

function audioSourceFromPublication(
  publication: RemoteTrackPublication,
): RemoteAudioSource {
  return publication.source === Track.Source.ScreenShareAudio ? 'stream' : 'mic'
}

function localMicMediaStreamTrack(track: LocalAudioTrackWithProcessor | undefined) {
  const processor = track?.getProcessor?.()
  if (
    processor?.name === SYRNIKE_MIC_PROCESSOR_NAME &&
    processor.processedTrack
  ) {
    return processor.processedTrack
  }
  return track?.mediaStreamTrack ?? null
}

function remoteAudioTrackId(
  track: Track,
  publication: RemoteTrackPublication,
) {
  const audioTrack = track as AudioTrackWithMedia
  return (
    publication.trackSid ??
    audioTrack.sid ??
    audioTrack.mediaStreamTrack?.id ??
    crypto.randomUUID()
  )
}

function rtcDebugScreenSlice(snapshot: RtcDebugSnapshot) {
  const localScreen = snapshot.screenShares.find((screen) => screen.isLocal)
  const remoteScreen = snapshot.screenShares.find((screen) => !screen.isLocal)
  const outboundVideo = snapshot.outbound.find(
    (stream) => stream.pcRole === 'publisher' && stream.kind === 'video',
  )
  const inboundVideo = snapshot.inbound.find(
    (stream) => stream.pcRole === 'subscriber' && stream.kind === 'video',
  )

  return {
    transport: {
      availableOutgoingBitrate: snapshot.transport.availableOutgoingBitrate,
      availableIncomingBitrate: snapshot.transport.availableIncomingBitrate,
      outboundBitrate: snapshot.rates?.transport.outboundBitrate,
      inboundBitrate: snapshot.rates?.transport.inboundBitrate,
      pingMs: snapshot.transport.pingMs,
    },
    outboundVideo: outboundVideo
      ? {
          bitrate: outboundVideo.bitrate,
          targetBitrate: outboundVideo.targetBitrate,
          framesEncoded: outboundVideo.framesEncoded,
          framesPerSecond: outboundVideo.framesPerSecond,
          frameWidth: outboundVideo.frameWidth,
          frameHeight: outboundVideo.frameHeight,
          qualityLimitationReason: outboundVideo.qualityLimitationReason,
          nackCount: outboundVideo.nackCount,
          pliCount: outboundVideo.pliCount,
        }
      : null,
    inboundVideo: inboundVideo
      ? {
          bitrate: inboundVideo.bitrate,
          framesDecoded: inboundVideo.framesDecoded,
          framesDropped: inboundVideo.framesDropped,
          framesPerSecond: inboundVideo.framesPerSecond,
          frameWidth: inboundVideo.frameWidth,
          frameHeight: inboundVideo.frameHeight,
          packetsLost: inboundVideo.packetsLost,
          jitter: inboundVideo.jitter,
          freezeCount: inboundVideo.freezeCount,
        }
      : null,
    localScreen: localScreen
      ? {
          live: localScreen.live,
          subscribed: localScreen.subscribed,
          captureBackend: localScreen.captureBackend,
          maxBitrate: localScreen.maxBitrate,
          maxFramerate: localScreen.maxFramerate,
          sentBitrate: localScreen.sentBitrate,
          fps: localScreen.fps,
          frameWidth: localScreen.frameWidth,
          frameHeight: localScreen.frameHeight,
          captureWidth: localScreen.captureWidth,
          captureHeight: localScreen.captureHeight,
          captureFrameRate: localScreen.captureFrameRate,
          captureVideoPublished: localScreen.captureVideoPublished,
          captureVideoFrames: localScreen.captureVideoFrames,
          captureVideoIntervalFrames: localScreen.captureVideoIntervalFrames,
          captureVideoLateFrames: localScreen.captureVideoLateFrames,
          captureVideoNoFrameCount: localScreen.captureVideoNoFrameCount,
          captureVideoRepeatedFrameCount:
            localScreen.captureVideoRepeatedFrameCount,
          captureVideoAvgCaptureUs: localScreen.captureVideoAvgCaptureUs,
          captureVideoAvgReadbackUs: localScreen.captureVideoAvgReadbackUs,
          captureVideoAvgScaleUs: localScreen.captureVideoAvgScaleUs,
          captureVideoAvgPublishUs: localScreen.captureVideoAvgPublishUs,
          captureThreadMmcss: localScreen.captureThreadMmcss,
          captureAudioPublished: localScreen.captureAudioPublished,
          captureAudioFrames: localScreen.captureAudioFrames,
          captureAudioPackets: localScreen.captureAudioPackets,
        }
      : null,
    remoteScreen: remoteScreen
      ? {
          live: remoteScreen.live,
          subscribed: remoteScreen.subscribed,
          receivedBitrate: remoteScreen.receivedBitrate,
          fps: remoteScreen.fps,
          frameWidth: remoteScreen.frameWidth,
          frameHeight: remoteScreen.frameHeight,
          packetsLost: remoteScreen.packetsLost,
        }
      : null,
  }
}

export function VoiceProvider({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const roomRef = useRef<Room | null>(null)
  const nativeScreenShareRef = useRef<NativeScreenShareSession | null>(null)
  const pendingScreenShareStartRef = useRef<{
    quality: ScreenShareQualityName
    withAudio: boolean
  } | null>(null)
  const screenShareStartGenerationRef = useRef(0)
  const stoppedNativeScreenIdentityRef = useRef<string | null>(null)
  const nativeMicrophoneRef = useRef<NativeMicrophoneSession | null>(null)
  const nativeMicrophoneStartRef = useRef<Promise<boolean> | null>(null)
  const nativeMicrophoneStartGenerationRef = useRef(0)
  const nativeMicrophoneMutedRef = useRef(false)
  const liveKitCredentialsRef = useRef<LiveKitNativeCredentials | null>(null)
  const watchedRemoteScreenIdsRef = useRef<Set<string>>(new Set())
  const pendingScreenWatchIdsRef = useRef<Set<string>>(new Set())
  const screenShareDebugUntilRef = useRef(0)
  const lastStageSyncDebugKeyRef = useRef<string | null>(null)
  const nativeScreenPublicationLossKeyRef = useRef<string | null>(null)
  const nativeScreenPublicationLostRef =
    useRef<NativeScreenPublicationLossHandler | null>(null)
  const remoteAudioMixerRef = useRef<RemoteAudioMixer | null>(null)
  const localSpeakingDetectorRef = useRef<LocalSpeakingDetector | null>(null)
  const remoteSpeakingUserIdsRef = useRef<ReadonlySet<string>>(new Set())
  const selfSpeakingRef = useRef(false)
  const authUserIdRef = useRef<string | null>(null)
  const channelIdRef = useRef<string | null>(null)
  const statusRef = useRef<VoiceStatus>('idle')
  const localVoiceReadyRef = useRef(false)
  const voiceConnectedAtRef = useRef(0)
  const deafenedRef = useRef(false)
  const micPublishingRef = useRef(readVoicePreferences().micEnabled)
  const micIssueRef = useRef<VoiceMicIssue | null>(null)
  const voiceTransitionAttemptsRef = useRef<number[]>([])
  const pendingReplacedVoiceRoomRef = useRef<{
    operationId: string
    room: Room
    channelId: string
    localVoiceReady: boolean
  } | null>(null)
  const joinInFlightRef = useRef<{
    channelId: string
    promise: Promise<boolean>
  } | null>(null)
  const voiceSessionControllerRef = useRef(createVoiceSessionController())
  const disconnectIntentRef = useRef<DisconnectIntent>('none')
  const remoteVoiceSupersedeInFlightRef = useRef(false)
  const selfMonitoringRef = useRef({
    active: false,
    restorePublishing: false,
    sequence: 0,
  })
  authUserIdRef.current = auth.user?._id ?? null
  const voiceJoinDepsRef = useRef<VoiceJoinRunnerDeps>({
    getToken: () => undefined as string | undefined,
    getLocalUserId: () => undefined as string | undefined,
    isJoinBlocked: () => false,
    getActiveSession: () => null,
    requestJoinOperation: (_channelId: string, _reason) => '',
    handleServerPrepareSucceeded: (_operationId: string) => {},
    handleRoomConnected: (_operationId: string) => {},
    handleRoomConnectFailed: (_operationId: string, _error: string) => {},
    isCurrentJoinOperation: (_operationId: string) => true,
    beginConnecting: (
      _channelId: string,
      _preview: ReturnType<typeof createConnectingLocalVoiceState>[],
    ) => {},
    setActiveRoom: (_room: Room) => {},
    disconnectReplacedSession: async (_session: ActiveVoiceSessionSnapshot) => {},
    restorePreviousSession: (
      _session: ActiveVoiceSessionSnapshot,
      _failedTargetChannelId: string,
    ) => {},
    dropPreviousSession: async (
      _session: ActiveVoiceSessionSnapshot,
      _failedTargetChannelId: string,
    ) => {},
    attachRoomHandlers: (_room: Room) => {},
    setLiveKitCredentials: (_credentials: LiveKitNativeCredentials) => {},
    setConnectionPhase: (_phase: VoiceConnectionPhase) => {},
    onRoomConnected: (_room: Room, _channelId: string) => {},
    onJoinSuccess: () => {},
    abortJoin: () => {},
  })
  const performVoiceJoinRef = useRef(
    createVoiceJoinRunner({
      getToken: () => voiceJoinDepsRef.current.getToken(),
      getLocalUserId: () => voiceJoinDepsRef.current.getLocalUserId(),
      isJoinBlocked: () => voiceJoinDepsRef.current.isJoinBlocked(),
      getActiveSession: () => voiceJoinDepsRef.current.getActiveSession(),
      requestJoinOperation: (channelId, reason) =>
        voiceJoinDepsRef.current.requestJoinOperation(channelId, reason),
      handleServerPrepareSucceeded: (operationId) =>
        voiceJoinDepsRef.current.handleServerPrepareSucceeded(operationId),
      handleRoomConnected: (operationId) =>
        voiceJoinDepsRef.current.handleRoomConnected(operationId),
      handleRoomConnectFailed: (operationId, error) =>
        voiceJoinDepsRef.current.handleRoomConnectFailed(operationId, error),
      isCurrentJoinOperation: (operationId) =>
        voiceJoinDepsRef.current.isCurrentJoinOperation?.(operationId) ?? true,
      beginConnecting: (channelId, preview) =>
        voiceJoinDepsRef.current.beginConnecting(channelId, preview),
      setActiveRoom: (room) => voiceJoinDepsRef.current.setActiveRoom(room),
      disconnectReplacedSession: (session) =>
        voiceJoinDepsRef.current.disconnectReplacedSession(session),
      restorePreviousSession: (session, failedTargetChannelId) =>
        voiceJoinDepsRef.current.restorePreviousSession(
          session,
          failedTargetChannelId,
        ),
      dropPreviousSession: (session, failedTargetChannelId) =>
        voiceJoinDepsRef.current.dropPreviousSession(
          session,
          failedTargetChannelId,
        ),
      attachRoomHandlers: (room) =>
        voiceJoinDepsRef.current.attachRoomHandlers(room),
      setLiveKitCredentials: (credentials) =>
        voiceJoinDepsRef.current.setLiveKitCredentials(credentials),
      setConnectionPhase: (phase) =>
        voiceJoinDepsRef.current.setConnectionPhase(phase),
      onRoomConnected: (room, channelId) =>
        voiceJoinDepsRef.current.onRoomConnected(room, channelId),
      onJoinSuccess: () => voiceJoinDepsRef.current.onJoinSuccess(),
      abortJoin: () => voiceJoinDepsRef.current.abortJoin(),
    }),
  )
  const voiceRejoinDepsRef = useRef<
    Pick<
      VoiceRejoinControllerOptions,
      'attemptRejoin' | 'onGiveUp' | 'isGatewayConnected' | 'shouldKeepTrying'
    >
  >({
    attemptRejoin: async (_channelId: string) => false,
    onGiveUp: () => {},
    isGatewayConnected: () => false,
    shouldKeepTrying: () => false,
  })
  const voiceRejoinRef = useRef(
    createVoiceRejoinController({
      attemptRejoin: (channelId) =>
        voiceRejoinDepsRef.current.attemptRejoin(channelId),
      onGiveUp: () => voiceRejoinDepsRef.current.onGiveUp(),
      isGatewayConnected: () => voiceRejoinDepsRef.current.isGatewayConnected(),
      shouldKeepTrying: (channelId) =>
        voiceRejoinDepsRef.current.shouldKeepTrying?.(channelId) ?? false,
    }),
  )
  const stageMediaItemsRef = useRef<VoiceStageMediaItem[]>([])
  const rtcDebugSnapshotRef = useRef<RtcDebugSnapshot | null>(null)
  const lastVoicePreferencesRef = useRef(readVoicePreferences())

  const [channelId, setChannelId] = useState<string | null>(null)
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [connectionPhase, setConnectionPhase] =
    useState<VoiceConnectionPhase>('idle')
  const [localVoiceReady, setLocalVoiceReady] = useState(false)
  const [micEnabled, setMicEnabled] = useState(
    () => readVoicePreferences().micEnabled,
  )
  const [micPublishing, setMicPublishing] = useState(
    () => readVoicePreferences().micEnabled,
  )
  const [micIssue, setMicIssue] = useState<VoiceMicIssue | null>(null)
  const inputDevices = useMediaDevices('audioinput')
  const videoDevices = useMediaDevices('videoinput')
  const [deafened, setDeafened] = useState(
    () => readVoicePreferences().deafened,
  )
  const [participantCount, setParticipantCount] = useState(0)
  const [speakingUserIds, setSpeakingUserIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const publishSpeakingUserIds = useCallback(() => {
    const next = mergeSpeakingUserIds({
      remoteUserIds: remoteSpeakingUserIdsRef.current,
      selfUserId: authUserIdRef.current,
      selfSpeaking: selfSpeakingRef.current,
    })
    setSpeakingUserIds((current) =>
      stringSetEquals(current, next) ? current : next,
    )
  }, [])
  const setRemoteSpeakingUserIds = useCallback(
    (next: ReadonlySet<string>) => {
      if (stringSetEquals(remoteSpeakingUserIdsRef.current, next)) return
      remoteSpeakingUserIdsRef.current = new Set(next)
      publishSpeakingUserIds()
    },
    [publishSpeakingUserIds],
  )
  const setSelfSpeaking = useCallback(
    (speaking: boolean) => {
      if (selfSpeakingRef.current === speaking) return
      selfSpeakingRef.current = speaking
      publishSpeakingUserIds()
    },
    [publishSpeakingUserIds],
  )
  if (!remoteAudioMixerRef.current) {
    remoteAudioMixerRef.current = createRemoteAudioMixer({
      onSpeakingUserIdsChange: setRemoteSpeakingUserIds,
    })
  }
  if (!localSpeakingDetectorRef.current) {
    localSpeakingDetectorRef.current = createLocalSpeakingDetector({
      onSpeakingChange: setSelfSpeaking,
    })
  }
  useEffect(() => {
    publishSpeakingUserIds()
  }, [auth.user?._id, publishSpeakingUserIds])
  const [voicePingMs, setVoicePingMs] = useState<number | null>(null)
  const [voicePingHistory, setVoicePingHistory] = useState<VoicePingSample[]>(
    [],
  )
  const [rtcDebugEnabled, setRtcDebugEnabled] = useState(false)
  const [rtcDebugSnapshot, setRtcDebugSnapshot] =
    useState<RtcDebugSnapshot | null>(null)
  const [rtcDebugHistory, setRtcDebugHistory] = useState<RtcDebugSnapshot[]>([])
  const [screenShareDebugRun, setScreenShareDebugRun] = useState(0)
  const [stageMediaItems, setStageMediaItemsState] = useState<
    VoiceStageMediaItem[]
  >([])
  const [stageMediaFilters, setStageMediaFiltersState] = useState(
    readStageMediaFilters,
  )
  const [cameraEnabled, setCameraEnabled] = useState(false)
  const [screenShareEnabled, setScreenShareEnabled] = useState(false)
  const [screenShareStarting, setScreenShareStarting] = useState(false)
  const screenShareStartingRef = useRef(false)
  const [nativeMediaState, dispatchNativeMediaState] = useReducer(
    nativeMediaReducer,
    undefined,
    createInitialNativeMediaState,
  )
  const nativeMediaStateRef = useRef(nativeMediaState)
  nativeMediaStateRef.current = nativeMediaState
  const dispatchNativeMedia = useCallback((action: NativeMediaAction) => {
    nativeMediaStateRef.current = nativeMediaReducer(
      nativeMediaStateRef.current,
      action,
    )
    dispatchNativeMediaState(action)
  }, [])
  const [focusedMediaId, setFocusedMediaId] = useState<string | null>(null)
  const [stageFocusNonce, setStageFocusNonce] = useState(0)
  const [stageFullscreen, setStageFullscreen] = useState(false)

  channelIdRef.current = channelId
  statusRef.current = status
  localVoiceReadyRef.current = localVoiceReady
  deafenedRef.current = deafened
  micPublishingRef.current = micPublishing

  useEffect(() => {
    resetLocalVoiceEventGuard()
    setLocalVoiceEventUserId(auth.user?._id)
    return () => {
      resetLocalVoiceEventGuard()
    }
  }, [auth.user?._id])

  const isCurrentVoiceSession = useCallback(
    (room: Room, targetChannelId: string | null) =>
      roomRef.current === room &&
      channelIdRef.current === targetChannelId &&
      statusRef.current === 'connected',
    [],
  )

  const setCurrentMicIssue = useCallback(
    (issue: VoiceMicIssue | null, notify = false) => {
      const previous = micIssueRef.current
      micIssueRef.current = issue
      setMicIssue(issue)

      if (issue && notify && previous?.hint !== issue.hint) {
        toast.error(issue.hint)
      }
    },
    [],
  )

  const setStageMediaItems = useCallback((items: VoiceStageMediaItem[]) => {
    stageMediaItemsRef.current = items
    setStageMediaItemsState(items)
  }, [])

  const publishScreenViewerSound = useCallback(
    (room: Room, screenOwnerId: string, action: 'join' | 'leave') => {
      return room.localParticipant
        .publishData(createScreenViewerSoundPayload({ action, screenOwnerId }), {
          reliable: true,
          destinationIdentities: [screenOwnerId],
          topic: SCREEN_VIEWER_SOUND_TOPIC,
        })
        .catch((error) => {
          if (import.meta.env.DEV) {
            console.warn('Failed to publish screen viewer sound intent', error)
          }
        })
    },
    [],
  )

  const publishScreenViewerLeaves = useCallback(
    async (room: Room) => {
      await Promise.all(
        Array.from(watchedRemoteScreenIdsRef.current).flatMap((mediaId) => {
          const screenOwnerId = stageScreenMediaUserId(mediaId)
          return screenOwnerId
            ? [publishScreenViewerSound(room, screenOwnerId, 'leave')]
            : []
        }),
      )
    },
    [publishScreenViewerSound],
  )

  const setStageMediaFilters: Dispatch<
    SetStateAction<StageMediaFilters>
  > = useCallback((next) => {
    setStageMediaFiltersState((previous) => {
      const value = typeof next === 'function' ? next(previous) : next
      writeStageMediaFilters(value)
      return value
    })
  }, [])

  const applyRemoteScreenParticipantSubscription = useCallback(
    (participant: RemoteParticipant, subscribed?: boolean) => {
      const userId = baseVoiceIdentity(participant.identity)
      const currentUserIds = new Set<string>()
      if (auth.user?._id) currentUserIds.add(auth.user._id)
      const liveKitIdentity = roomRef.current?.localParticipant.identity
      if (liveKitIdentity) currentUserIds.add(baseVoiceIdentity(liveKitIdentity))
      const mediaId = stageMediaItemId(
        userId,
        'screen',
      )
      const nextSubscribed =
        subscribed ??
        shouldSubscribeStageScreen({
          isLocal: false,
          mediaId,
          currentUserIds,
          watchedRemoteScreenIds: watchedRemoteScreenIdsRef.current,
          pendingScreenWatchIds: pendingScreenWatchIdsRef.current,
        })

      for (const publication of participant.trackPublications.values()) {
        applyStageScreenPublicationSubscription(publication, nextSubscribed)
      }

      return nextSubscribed
    },
    [auth.user?._id],
  )

  const syncStageMediaItems = useCallback(
    (room: Room) => {
      const currentNativeMediaState = nativeMediaStateRef.current
      const excludedNativeScreenIdentity = stoppedNativeScreenIdentityRef.current
      const excludedParticipantIdentities = excludedNativeScreenIdentity
        ? new Set([excludedNativeScreenIdentity])
        : undefined
      const authUserId = auth.user?._id
      const liveKitIdentity = room.localParticipant.identity
      const currentUserIds = new Set<string>()
      if (authUserId) currentUserIds.add(authUserId)
      currentUserIds.add(baseVoiceIdentity(liveKitIdentity))
      const participants = liveKitRoomParticipantIds(room, {
        excludedParticipantIdentities,
      }).map((id) => ({ id }))
      const tracks: StageMediaTrackEntry<
        VideoTrack,
        VoiceStageMediaPublication
      >[] = []
      const ingest = (
        userId: string,
        publication: VoiceStageMediaPublication | null | undefined,
        isLocalPublication: boolean,
      ) => {
        if (!publication) return
        const source = stageMediaTrackSource(publication.source)
        if (!source) return
        const normalizedUserId = baseVoiceIdentity(userId)
        const mediaId = stageMediaItemId(normalizedUserId, source)
        const subscribed =
          source === 'screen'
            ? shouldSubscribeStageScreen({
                isLocal: isLocalPublication,
                mediaId,
                currentUserIds,
                watchedRemoteScreenIds: watchedRemoteScreenIdsRef.current,
                pendingScreenWatchIds: pendingScreenWatchIdsRef.current,
              })
            : publication.isSubscribed !== false
        if (!isLocalPublication && source === 'screen') {
          applyStageScreenPublicationSubscription(publication, subscribed)
        }
        const track =
          publication.track?.kind === Track.Kind.Video
            ? (publication.track as VideoTrack)
            : null
        if (source === 'camera' && (!track || !subscribed)) return
        tracks.push({
          userId: normalizedUserId,
          source,
          track,
          publication,
          subscribed,
          live: publication.isMuted !== true,
        })
      }

      for (const publication of room.localParticipant.trackPublications.values()) {
        ingest(room.localParticipant.identity, publication, true)
      }

      for (const participant of room.remoteParticipants.values()) {
        if (participant.identity === excludedNativeScreenIdentity) continue
        applyRemoteScreenParticipantSubscription(participant)
        for (const publication of participant.trackPublications.values()) {
          ingest(participant.identity, publication, false)
        }
      }

      const items = buildStageMediaItems({
        participants,
        currentUserId: authUserId ?? baseVoiceIdentity(liveKitIdentity),
        tracks,
        filters: stageMediaFilters,
      }).map((item) => ({
        ...item,
        isLocal: isVoiceLocalUserId(item.userId, authUserId, liveKitIdentity),
      }))
      const nativeScreenParticipants = Array.from(
        room.remoteParticipants.values(),
      ).filter((participant) =>
        isDesktopNativeVoiceIdentity(participant.identity) &&
        participant.identity.endsWith(':screen'),
      )
      const nativeScreenPublications = nativeScreenParticipants.reduce(
        (count, participant) =>
          count +
          Array.from(participant.trackPublications.values()).filter(
            (publication) => publication.source === Track.Source.ScreenShare,
          ).length,
        0,
      )
      const screenItems = items.filter((item) => item.kind === 'screen')
      const localScreenItems = screenItems.filter((item) => item.isLocal)
      const nativeScreenPublicationPresent =
        currentNativeMediaState.screen.status === 'published'
          ? hasCurrentNativeScreenPublication(room, currentNativeMediaState.screen)
          : null
      const stageDebugKey = JSON.stringify({
        nativeScreenState: currentNativeMediaState.screen.status,
        nativeScreenVisible: currentNativeMediaState.screen.visibleInRoom,
        remoteParticipants: room.remoteParticipants.size,
        nativeScreenParticipants: nativeScreenParticipants.length,
        nativeScreenPublications,
        nativeScreenPublicationPresent,
        tracks: tracks.length,
        screenItems: screenItems.length,
        localScreenItems: localScreenItems.length,
      })
      if (
        lastStageSyncDebugKeyRef.current !== stageDebugKey &&
        (currentNativeMediaState.screen.status !== 'idle' ||
          nativeScreenParticipants.length > 0 ||
          screenItems.length > 0)
      ) {
        lastStageSyncDebugKeyRef.current = stageDebugKey
        logVoiceDebugAgent({
          hypothesis: 'H3-stage-native-screen-loss',
          event: 'stage-sync-screen-state',
          nativeScreenState: currentNativeMediaState.screen.status,
          nativeScreenVisible: currentNativeMediaState.screen.visibleInRoom,
          remoteParticipants: room.remoteParticipants.size,
          nativeScreenParticipants: nativeScreenParticipants.length,
          nativeScreenPublications,
          nativeScreenPublicationPresent,
          tracks: tracks.length,
          screenItems: screenItems.length,
          localScreenItems: localScreenItems.length,
          localScreenLive: localScreenItems.some((item) => item.live),
        })
      }
      if (
        currentNativeMediaState.screen.status === 'published' &&
        nativeScreenPublicationPresent === false &&
        stoppedNativeScreenIdentityRef.current !==
          currentNativeMediaState.screen.participantIdentity
      ) {
        nativeScreenPublicationLostRef.current?.({
          reason: 'publication-missing',
          participantIdentity: currentNativeMediaState.screen.participantIdentity,
          publicationSid: currentNativeMediaState.screen.publicationSid,
          remoteParticipants: room.remoteParticipants.size,
        })
      }

      const visibleRemoteScreenIds = new Set(
        items
          .filter((item) => item.kind === 'screen' && !item.isLocal)
          .map((item) => item.id),
      )
      const remoteParticipantUserIds = new Set(
        Array.from(room.remoteParticipants.values()).map((participant) =>
          baseVoiceIdentity(participant.identity),
        ),
      )
      pruneWatchedRemoteScreenIds(
        watchedRemoteScreenIdsRef.current,
        pendingScreenWatchIdsRef.current,
        visibleRemoteScreenIds,
        remoteParticipantUserIds,
      )

      for (const item of items) {
        if (item.kind !== 'screen' || item.isLocal || item.subscribed === false) {
          continue
        }
        pendingScreenWatchIdsRef.current.delete(item.id)
        watchedRemoteScreenIdsRef.current.add(item.id)
      }

      setStageMediaItems(items)
    },
    [
      applyRemoteScreenParticipantSubscription,
      auth.user?._id,
      setStageMediaItems,
      stageMediaFilters,
    ],
  )

  const syncRoomParticipants = useCallback(() => {
    const room = roomRef.current
    if (!room) return
    const localMedia = localParticipantVoiceFlags(room.localParticipant)
    const activeChannelId = channelIdRef.current
    const userId = auth.user?._id
    setCameraEnabled(localMedia.camera)
    setScreenShareEnabled(
      localMedia.screensharing ||
        isNativeScreenPublished(nativeMediaStateRef.current),
    )
    if (activeChannelId && userId) {
      patchLocalVoiceCamera(activeChannelId, userId, localMedia.camera)
    }
    syncStageMediaItems(room)
  }, [auth.user?._id, syncStageMediaItems])

  const cleanupAudio = useCallback(() => {
    remoteAudioMixerRef.current?.clear()
    localSpeakingDetectorRef.current?.clear()
    setSelfSpeaking(false)
    for (const element of document.querySelectorAll(
      'audio[data-syrnike-remote-audio-mixer="source"]',
    )) {
      element.remove()
    }
  }, [setSelfSpeaking])

  const applyRemoteAudio = useCallback((deafened = deafenedRef.current) => {
    remoteAudioMixerRef.current?.applyVolumes(deafened)
  }, [])

  const syncLocalSpeakingTrack = useCallback(
    (room = roomRef.current) => {
      const detector = localSpeakingDetectorRef.current
      if (!detector) return

      if (!room || shouldUseNativeMicrophone()) {
        detector.clear()
        detector.setEnabled(false)
        if (!shouldUseNativeMicrophone()) {
          setSelfSpeaking(false)
        }
        return
      }

      const micPublication = room.localParticipant.getTrackPublication(
        Track.Source.Microphone,
      )
      const audioTrack = micPublication?.audioTrack as
        | LocalAudioTrackWithProcessor
        | undefined
      const mediaStreamTrack = localMicMediaStreamTrack(audioTrack)
      const enabled =
        participantMicPublishing(room.localParticipant) &&
        !deafenedRef.current &&
        !selfMonitoringRef.current.active

      detector.setTrack(mediaStreamTrack)
      detector.setEnabled(enabled)
      if (!mediaStreamTrack || !enabled) {
        setSelfSpeaking(false)
      }
    },
    [setSelfSpeaking],
  )

  const restoreVoicePreferences = useCallback(() => {
    const prefs = readVoicePreferences()
    setMicEnabled(prefs.micEnabled)
    setMicPublishing(prefs.micEnabled)
    setCurrentMicIssue(null)
    setDeafened(prefs.deafened)
    deafenedRef.current = prefs.deafened
  }, [setCurrentMicIssue])

  const syncMicFromRoom = useCallback(
    (room: Room, issue?: VoiceMicIssue | null) => {
      const wantsMic = voicePreferenceStore.getMicEnabled()
      const publishing = participantMicPublishing(room.localParticipant)
      const effectivePublishing =
        shouldUseNativeMicrophone() && nativeMicrophoneRef.current
          ? !nativeMicrophoneMutedRef.current
          : publishing
      const activeChannelId = channelIdRef.current
      const userId = auth.user?._id

      setMicPublishing(effectivePublishing)

      if (
        shouldResetMicPreferenceOnIssue({
          wantsMic,
          micPublishing: effectivePublishing,
          micIssue: issue ?? null,
        })
      ) {
        voicePreferenceStore.setMicEnabled(false)
        setMicEnabled(false)
      }

      if (issue !== undefined) {
        setCurrentMicIssue(issue, issue != null)
      } else if (effectivePublishing) {
        setCurrentMicIssue(null)
      } else if (wantsMic) {
        const fallbackIssue = micIssueRef.current ?? MIC_BLOCKED_WITHOUT_ERROR
        if (
          shouldResetMicPreferenceOnIssue({
            wantsMic,
            micPublishing: effectivePublishing,
            micIssue: fallbackIssue,
          })
        ) {
          voicePreferenceStore.setMicEnabled(false)
          setMicEnabled(false)
        }
        setCurrentMicIssue(fallbackIssue, true)
      } else {
        setCurrentMicIssue(null)
      }

      if (activeChannelId && userId) {
        patchLocalVoiceMic(activeChannelId, userId, effectivePublishing)
      }
    },
    [auth.user?._id, setCurrentMicIssue],
  )

  const syncVoiceFlagsToGateway = useCallback(
    (channelId: string, selfMute: boolean, selfDeaf: boolean) => {
      requestVoiceFlagsUpdate(channelId, selfMute, selfDeaf)
    },
    [],
  )

  const readCurrentVoiceFlags = useCallback((room = roomRef.current) => {
    const selfDeaf = deafenedRef.current
    if (selfDeaf || selfMonitoringRef.current.active) {
      return { selfMute: true, selfDeaf }
    }
    if (room) {
      if (shouldUseNativeMicrophone()) {
        return {
          selfMute: !nativeMicrophoneRef.current || nativeMicrophoneMutedRef.current,
          selfDeaf,
        }
      }
      return {
        selfMute: !participantMicPublishing(room.localParticipant),
        selfDeaf,
      }
    }
    return { selfMute: !micPublishingRef.current, selfDeaf }
  }, [])

  const refreshNativeLiveKitCredentials = useCallback(
    async (
      mediaKind: LiveKitNativeMediaKind,
      force = false,
    ): Promise<LiveKitNativePublisherCredentials> => {
      const current = liveKitCredentialsRef.current
      if (
        !force &&
        current &&
        !shouldRefreshLiveKitToken(current[mediaKind])
      ) {
        return current[mediaKind]
      }

      const activeChannelId = channelIdRef.current
      if (!activeChannelId) {
        throw new Error('LiveKit credentials are not available')
      }

      const { selfMute, selfDeaf } = readCurrentVoiceFlags()
      const credentials = await runVoiceRequest(
        `voice_refresh:${activeChannelId}:native`,
        () =>
          requestVoiceCredentialsRefresh(
            activeChannelId,
            selfMute,
            selfDeaf,
            createVoiceOperationId(),
          ),
        10_000,
      )
      if (!credentials) {
        throw new Error('Не удалось обновить LiveKit token')
      }

      const next = nativeCredentialsFromJoinResponse(credentials)
      liveKitCredentialsRef.current = next
      const desktop = getSyrnikeDesktop()
      if (desktop?.platform.os === 'win32') {
        void desktop.media.prepareScreenSession({ livekit: next.screen }).catch(() => {})
      }
      return next[mediaKind]
    },
    [auth.gatewayState, readCurrentVoiceFlags],
  )

  const activeChannelAudioBitrateKbps = useCallback(() => {
    const activeChannelId = channelIdRef.current
    const channel = activeChannelId
      ? syncStore.getState().channels[activeChannelId]
      : null
    return channelAudioBitrateKbps(
      channel && 'voice' in channel ? channel : {},
    )
  }, [])

  const resetVoiceState = useCallback(() => {
    nativeMicrophoneStartGenerationRef.current += 1
    nativeMicrophoneStartRef.current = null
    screenShareStartGenerationRef.current += 1
    screenShareStartingRef.current = false
    pendingScreenShareStartRef.current = null
    const activeNativeMicrophone = nativeMicrophoneRef.current
    if (activeNativeMicrophone) {
      nativeMicrophoneRef.current = null
      activeNativeMicrophone.disconnect()
    }
    nativeMicrophoneMutedRef.current = false
    selfMonitoringRef.current.restorePublishing = false
    selfMonitoringRef.current.sequence += 1
    if (nativeScreenShareRef.current) {
      void nativeScreenShareRef.current.stop().catch(() => {})
      nativeScreenShareRef.current = null
      nativeMediaEngineStatsStore.reset()
    }
    stoppedNativeScreenIdentityRef.current = null
    nativeScreenPublicationLossKeyRef.current = null
    watchedRemoteScreenIdsRef.current.clear()
    pendingScreenWatchIdsRef.current.clear()
    const desktop = getSyrnikeDesktop()
    if (desktop?.platform.os === 'win32') {
      void desktop.media.cancelPendingStarts().catch(() => {})
      void desktop.media.disconnectPreparedScreenSession().catch(() => {})
    }
    setChannelId(null)
    setStatus('idle')
    voiceConnectedAtRef.current = 0
    setConnectionPhase('idle')
    setLocalVoiceReady(false)
    restoreVoicePreferences()
    setCurrentMicIssue(null)
    setParticipantCount(0)
    remoteSpeakingUserIdsRef.current = new Set()
    selfSpeakingRef.current = false
    setSpeakingUserIds((current) => (current.size === 0 ? current : new Set()))
    setVoicePingMs(null)
    setVoicePingHistory([])
    rtcDebugSnapshotRef.current = null
    setRtcDebugSnapshot(null)
    setRtcDebugHistory([])
    setStageMediaItems([])
    setCameraEnabled(false)
    setScreenShareEnabled(false)
    setScreenShareStarting(false)
    dispatchNativeMedia({ type: 'reset' })
    setFocusedMediaId(null)
    setStageFullscreen(false)
  }, [
    restoreVoicePreferences,
    setCurrentMicIssue,
    setStageMediaItems,
  ])

  const abortJoinAttempt = useCallback(() => {
    const activeChannelId = channelIdRef.current
    const userId = auth.user?._id
    if (activeChannelId && userId) {
      syncStore.removeVoiceParticipant(activeChannelId, userId)
    }
    voiceRejoinRef.current.cancel()
    cleanupAudio()
    resetVoiceState()
  }, [auth.user?._id, cleanupAudio, resetVoiceState])

  const disconnectPendingReplacedVoiceRoom = useCallback(() => {
    const pendingSource = pendingReplacedVoiceRoomRef.current
    if (!pendingSource) return null

    pendingReplacedVoiceRoomRef.current = null
    if (pendingSource.room !== roomRef.current) {
      pendingSource.room.removeAllListeners()
      void pendingSource.room.disconnect().catch(() => {})
    }
    return pendingSource
  }, [])

  const leaveVoiceSession = useCallback(
    async (intent: Exclude<DisconnectIntent, 'none'> = 'switch') => {
      voiceRejoinRef.current.cancel()
      if (intent === 'leave') {
        voiceTransitionAttemptsRef.current = recordVoiceTransitionAttempt(
          voiceTransitionAttemptsRef.current,
          Date.now(),
        )
      }
      const activeOperationId =
        voiceSessionControllerRef.current.getState().activeOperationId
      rememberCanceledVoiceOperation(activeOperationId)
      const leaveOperationId = voiceSessionControllerRef.current.requestLeave()
      const pendingSource = disconnectPendingReplacedVoiceRoom()
      const room = roomRef.current
      const leftChannelId = channelIdRef.current
      const userId =
        room?.localParticipant.identity ??
        pendingSource?.room.localParticipant.identity ??
        auth.user?._id

      if (room) {
        await publishScreenViewerLeaves(room)
        disconnectIntentRef.current = intent
        room.removeAllListeners()
        await room.disconnect()
        roomRef.current = null
      }

      cleanupAudio()
      clearSessionVoiceGateThreshold()
      resetVoiceState()
      if (intent === 'leave') {
        playUiSound('voice.disconnect')
      }

      if (intent === 'leave' && auth.gatewayState === 'connected') {
        requestVoiceLeave()
      }

      if (leftChannelId && userId) {
        syncStore.removeVoiceParticipant(leftChannelId, userId)
      }
      if (pendingSource?.channelId && userId) {
        syncStore.removeVoiceParticipant(pendingSource.channelId, userId)
      } else if (userId) {
        removeLocalUserFromAllVoiceChannels(userId)
      }

      voiceSessionControllerRef.current.handleRoomDisconnected({
        operationId: leaveOperationId,
        expected: true,
      })
      disconnectIntentRef.current = 'none'
    },
    [
      auth.gatewayState,
      auth.user?._id,
      cleanupAudio,
      publishScreenViewerLeaves,
      resetVoiceState,
    ],
  )

  const leave = useCallback(() => {
    void leaveVoiceSession('leave')
  }, [leaveVoiceSession])

  const stopRemoteSupersededVoiceSession = useCallback(
    (reason: string, targetChannelId?: string) => {
      if (remoteVoiceSupersedeInFlightRef.current) return
      if (!channelIdRef.current && !roomRef.current) return

      remoteVoiceSupersedeInFlightRef.current = true
      console.warn('[voice-session] local voice session superseded', {
        reason,
        currentChannelId: channelIdRef.current,
        targetChannelId,
      })
      void leaveVoiceSession('switch').finally(() => {
        remoteVoiceSupersedeInFlightRef.current = false
      })
    },
    [leaveVoiceSession],
  )

  const leaveVoiceSessionRef = useRef(leaveVoiceSession)
  useEffect(() => {
    leaveVoiceSessionRef.current = leaveVoiceSession
  }, [leaveVoiceSession])

  const applyVoiceDevices = useCallback(async (room: Room) => {
    const prefs = readVoicePreferences()
    if (prefs.preferredAudioInputDevice && !shouldUseNativeMicrophone()) {
      await switchDeviceWithTimeout(
        room,
        'audioinput',
        prefs.preferredAudioInputDevice,
      )
    }
    if (prefs.preferredAudioOutputDevice) {
      await switchDeviceWithTimeout(
        room,
        'audiooutput',
        prefs.preferredAudioOutputDevice,
      )
    }
    remoteAudioMixerRef.current?.setOutputDevice(prefs.preferredAudioOutputDevice)
    applyRemoteAudio(deafenedRef.current)
  }, [applyRemoteAudio])

  const setNativeMicrophoneMuted = useCallback(
    async (muted: boolean) => {
      const previousMuted = nativeMicrophoneMutedRef.current
      nativeMicrophoneMutedRef.current = muted
      const active = nativeMicrophoneRef.current
      setMicPublishing(Boolean(active) && !muted)
      if (muted) setSelfSpeaking(false)
      if (!active) return
      try {
        await active.setMuted(muted)
        syncRoomParticipants()
      } catch (error) {
        nativeMicrophoneMutedRef.current = previousMuted
        setMicPublishing(Boolean(nativeMicrophoneRef.current) && !previousMuted)
        throw error
      }
    },
    [setSelfSpeaking, syncRoomParticipants],
  )

  const startNativeMicrophone = useCallback(
    async (room: Room, muted = false) => {
      const targetChannelId = channelIdRef.current
      if (!isCurrentVoiceSession(room, targetChannelId)) {
        return false
      }
      const active = nativeMicrophoneRef.current
      if (active) {
        await setNativeMicrophoneMuted(muted)
        return isCurrentVoiceSession(room, targetChannelId)
      }
      const pendingNativeMicrophoneStart = nativeMicrophoneStartRef.current
      if (pendingNativeMicrophoneStart) {
        const started = await pendingNativeMicrophoneStart
        if (!started || !isCurrentVoiceSession(room, targetChannelId)) {
          return false
        }
        if (nativeMicrophoneRef.current) {
          await setNativeMicrophoneMuted(muted)
        } else {
          nativeMicrophoneMutedRef.current = muted
        }
        return isCurrentVoiceSession(room, targetChannelId)
      }

      nativeMicrophoneMutedRef.current = muted
      const startGeneration = nativeMicrophoneStartGenerationRef.current
      const requestId = crypto.randomUUID()
      const start = (async (): Promise<boolean> => {
        let session: NativeMicrophoneSession
        try {
          if (!isCurrentVoiceSession(room, targetChannelId)) {
            return false
          }
          session = await publishNativeMicrophone(
            room.localParticipant,
            (sessionId) => {
              if (nativeMicrophoneRef.current?.sessionId !== sessionId) return
              nativeMicrophoneRef.current = null
              nativeMicrophoneMutedRef.current = false
              setMicPublishing(false)
              setSelfSpeaking(false)
              const activeChannelId = channelIdRef.current
              const userId = auth.user?._id
              if (activeChannelId && userId) {
                patchLocalVoiceMic(activeChannelId, userId, false)
                syncVoiceFlagsToGateway(
                  activeChannelId,
                  true,
                  deafenedRef.current,
                )
              }
              syncRoomParticipants()

              const prefs = readVoicePreferences()
              const room = roomRef.current
              const shouldRestart =
                room &&
                shouldRestartNativeMicrophonePublisher({
                  voiceConnected: statusRef.current === 'connected',
                  wantsMic: prefs.micEnabled,
                  deafened: deafenedRef.current,
                  selfMonitoringActive: selfMonitoringRef.current.active,
                })

              if (!shouldRestart) return

              void startNativeMicrophone(room, false)
                .then((started) => {
                  if (!started || !isCurrentVoiceSession(room, activeChannelId)) {
                    return
                  }
                  syncMicFromRoom(room)
                  syncRoomParticipants()
                  if (activeChannelId && userId && statusRef.current === 'connected') {
                    const { selfMute, selfDeaf } = readCurrentVoiceFlags(room)
                    syncVoiceFlagsToGateway(activeChannelId, selfMute, selfDeaf)
                  }
                })
                .catch((error) => {
                  if (!isCurrentVoiceSession(room, activeChannelId)) {
                    return
                  }
                  syncMicFromRoom(room, describeMicDeviceError(error))
                  syncRoomParticipants()
                  if (activeChannelId && userId && statusRef.current === 'connected') {
                    syncVoiceFlagsToGateway(
                      activeChannelId,
                      true,
                      deafenedRef.current,
                    )
                  }
                })
            },
            await refreshNativeLiveKitCredentials('microphone'),
            requestId,
            muted,
            activeChannelAudioBitrateKbps(),
          )
        } catch (error) {
          if (!isCurrentVoiceSession(room, targetChannelId)) {
            return false
          }
          throw error
        }

        if (
          nativeMicrophoneStartGenerationRef.current !== startGeneration ||
          !isCurrentVoiceSession(room, targetChannelId)
        ) {
          session.disconnect()
          return false
        }

        nativeMicrophoneRef.current = session
        setMicPublishing(!muted)
        if (muted) setSelfSpeaking(false)
        syncRoomParticipants()
        return true
      })()

      nativeMicrophoneStartRef.current = start
      try {
        return await start
      } finally {
        if (nativeMicrophoneStartRef.current === start) {
          nativeMicrophoneStartRef.current = null
        }
      }
    },
    [
      refreshNativeLiveKitCredentials,
      activeChannelAudioBitrateKbps,
      auth.user?._id,
      isCurrentVoiceSession,
      readCurrentVoiceFlags,
      setSelfSpeaking,
      setNativeMicrophoneMuted,
      syncMicFromRoom,
      syncRoomParticipants,
      syncVoiceFlagsToGateway,
    ],
  )

  const runVoiceRecovery = useCallback(
    (trigger: string) => {
      const activeChannelId = channelIdRef.current
      const sessionState = voiceSessionControllerRef.current.getState()
      const desiredChannelId =
        sessionState.desired.kind === 'channel'
          ? sessionState.desired.channelId
          : null
      const room = roomRef.current
      const { selfMute, selfDeaf } = readCurrentVoiceFlags(room)
      const prefs = readVoicePreferences()
      const publisherHealthy = room
        ? shouldUseNativeMicrophone()
          ? Boolean(nativeMicrophoneRef.current && !nativeMicrophoneMutedRef.current)
          : participantMicPublishing(room.localParticipant)
        : false

      const action = decideVoiceRecoveryAction({
        gatewayConnected: auth.gatewayState === 'connected',
        channelId: activeChannelId,
        desiredChannelId,
        userId: auth.user?._id,
        status: statusRef.current,
        voiceParticipants: syncStore.getState().voiceParticipants,
        canTrustServerState:
          trigger === 'gateway_connected' ||
          (voiceConnectedAtRef.current > 0 &&
            Date.now() - voiceConnectedAtRef.current >=
              VOICE_RECOVERY_SERVER_STATE_GRACE_MS),
        desiredSelfMute: selfMute,
        desiredSelfDeaf: selfDeaf,
        wantsMic: prefs.micEnabled,
        selfMonitoringActive: selfMonitoringRef.current.active,
        publisherHealthy,
      })

      if (action.type === 'none') return

      if (action.type === 'stop_superseded') {
        stopRemoteSupersededVoiceSession(
          action.reason,
          action.channelId,
        )
        return
      }

      if (action.type === 'rejoin') {
        const targetChannelId = action.channelId
        const pendingRejoin = voiceRejoinRef.current.getPendingChannelId()
        if (pendingRejoin === targetChannelId) return
        if (joinInFlightRef.current?.channelId === targetChannelId) return

        console.warn('[voice-recovery] rejoining voice session', {
          trigger,
          reason: action.reason,
          channelId: targetChannelId,
          status: statusRef.current,
        })

        const promise = (async () => {
          await leaveVoiceSession('switch')
          const ok = await performVoiceJoinRef.current(targetChannelId, {
            rejoin: true,
          })
          if (!ok) {
            voiceRejoinRef.current.onUnexpectedDisconnect(targetChannelId)
          }
          return ok
        })()

        joinInFlightRef.current = {
          channelId: targetChannelId,
          promise,
        }
        void promise.finally(() => {
          if (joinInFlightRef.current?.channelId === targetChannelId) {
            joinInFlightRef.current = null
          }
        })
        return
      }

      if (!activeChannelId) return

      if (action.type === 'send_flags') {
        console.info('[voice-recovery] syncing voice flags', {
          trigger,
          reason: action.reason,
          channelId: activeChannelId,
          selfMute: action.selfMute,
          selfDeaf: action.selfDeaf,
        })
        syncVoiceFlagsToGateway(
          activeChannelId,
          action.selfMute,
          action.selfDeaf,
        )
        return
      }

      if (action.type === 'repair_publisher') {
        if (!room) {
          console.warn('[voice-recovery] cannot repair publisher without room', {
            trigger,
            channelId: activeChannelId,
          })
          return
        }

        console.warn('[voice-recovery] repairing voice publisher', {
          trigger,
          reason: action.reason,
          channelId: activeChannelId,
        })

        if (shouldUseNativeMicrophone()) {
          void startNativeMicrophone(room, false)
            .then((started) => {
              if (!started || !isCurrentVoiceSession(room, activeChannelId)) {
                return
              }
              syncMicFromRoom(room)
              syncRoomParticipants()
              const flags = readCurrentVoiceFlags(room)
              syncVoiceFlagsToGateway(
                activeChannelId,
                flags.selfMute,
                flags.selfDeaf,
              )
            })
            .catch((error) => {
              if (!isCurrentVoiceSession(room, activeChannelId)) {
                return
              }
              syncMicFromRoom(room, describeMicDeviceError(error))
              syncRoomParticipants()
              syncVoiceFlagsToGateway(
                activeChannelId,
                true,
                deafenedRef.current,
              )
            })
          return
        }

        void room.localParticipant
          .setMicrophoneEnabled(
            true,
            undefined,
            voiceMicPublishOptions(activeChannelAudioBitrateKbps()),
          )
          .then(() => applyMicProcessing(room.localParticipant))
          .then(() => {
            if (!isCurrentVoiceSession(room, activeChannelId)) {
              return
            }
            syncLocalSpeakingTrack(room)
            syncMicFromRoom(room)
            syncRoomParticipants()
            const flags = readCurrentVoiceFlags(room)
            syncVoiceFlagsToGateway(
              activeChannelId,
              flags.selfMute,
              flags.selfDeaf,
            )
          })
          .catch((error) => {
            if (!isCurrentVoiceSession(room, activeChannelId)) {
              return
            }
            syncMicFromRoom(room, describeMicDeviceError(error))
            syncRoomParticipants()
            syncVoiceFlagsToGateway(
              activeChannelId,
              true,
              deafenedRef.current,
            )
          })
        return
      }

    },
    [
      activeChannelAudioBitrateKbps,
      applyMicProcessing,
      auth.gatewayState,
      auth.user?._id,
      isCurrentVoiceSession,
      leaveVoiceSession,
      readCurrentVoiceFlags,
      startNativeMicrophone,
      stopRemoteSupersededVoiceSession,
      syncLocalSpeakingTrack,
      syncMicFromRoom,
      syncRoomParticipants,
      syncVoiceFlagsToGateway,
    ],
  )

  const finishLocalVoiceSetup = useCallback(
    async (room: Room, targetChannelId: string) => {
      if (!isCurrentVoiceSession(room, targetChannelId)) {
        return
      }
      const prefs = effectiveVoiceJoinPreferences(readVoicePreferences())
      const suppressedBySelfMonitoring =
        selfMonitoringRef.current.active && prefs.micEnabled
      let micSetupFailed = false
      try {
        if (shouldUseNativeMicrophone()) {
          const nativeStarted = await startNativeMicrophone(
            room,
            !prefs.micEnabled || suppressedBySelfMonitoring || prefs.deafened,
          )
          if (!nativeStarted || !isCurrentVoiceSession(room, targetChannelId)) {
            return
          }
        } else {
          await room.localParticipant.setMicrophoneEnabled(
            prefs.micEnabled && !suppressedBySelfMonitoring,
            undefined,
            voiceMicPublishOptions(activeChannelAudioBitrateKbps()),
          )
          if (!isCurrentVoiceSession(room, targetChannelId)) {
            return
          }
        }
      } catch (error) {
        if (!isCurrentVoiceSession(room, targetChannelId)) {
          return
        }
        micSetupFailed = true
        setConnectionPhase('failed')
        syncMicFromRoom(room, describeMicDeviceError(error))
      }
      setMicEnabled(voicePreferenceStore.getMicEnabled())
      if (suppressedBySelfMonitoring) {
        selfMonitoringRef.current.restorePublishing = true
        setMicPublishing(false)
        setCurrentMicIssue(null)
      } else if (!micSetupFailed) {
        syncMicFromRoom(room)
      }
      setDeafened(prefs.deafened)
      deafenedRef.current = prefs.deafened
      applyRemoteAudio(prefs.deafened)
      await applyVoiceDevices(room)
      if (!isCurrentVoiceSession(room, targetChannelId)) {
        return
      }
      if (
        prefs.micEnabled &&
        !suppressedBySelfMonitoring &&
        !micSetupFailed &&
        !shouldUseNativeMicrophone()
      ) {
        await applyMicProcessing(room.localParticipant)
        if (!isCurrentVoiceSession(room, targetChannelId)) {
          return
        }
      }
      syncLocalSpeakingTrack(room)
      syncRoomParticipants()

      if (!isCurrentVoiceSession(room, targetChannelId)) {
        return
      }
      const userId = auth.user?._id
      if (userId) {
        const nextMicPublishing = suppressedBySelfMonitoring
          ? false
          : shouldUseNativeMicrophone()
            ? Boolean(
                nativeMicrophoneRef.current &&
                  !nativeMicrophoneMutedRef.current,
              )
            : participantMicPublishing(room.localParticipant)
        patchLocalVoiceDeafen(targetChannelId, userId, prefs.deafened)
        syncVoiceFlagsToGateway(
          targetChannelId,
          !nextMicPublishing,
          prefs.deafened,
        )
      }
      if (!isCurrentVoiceSession(room, targetChannelId)) {
        return
      }
      setLocalVoiceReady(true)
      if (!micSetupFailed) {
        setConnectionPhase('connected')
      }
    },
    [
      applyVoiceDevices,
      auth.user?._id,
      isCurrentVoiceSession,
      setCurrentMicIssue,
      startNativeMicrophone,
      activeChannelAudioBitrateKbps,
      syncMicFromRoom,
      syncLocalSpeakingTrack,
      syncRoomParticipants,
      syncVoiceFlagsToGateway,
    ],
  )

  const setSelfMonitoringActive = useCallback(
    (active: boolean) => {
      const room = roomRef.current
      const activeChannelId = channelIdRef.current
      const userId = auth.user?._id
      if (selfMonitoringRef.current.active === active) return
      const sequence = selfMonitoringRef.current.sequence + 1
      selfMonitoringRef.current.sequence = sequence
      selfMonitoringRef.current.active = active

      if (!room || !activeChannelId) {
        if (!active) {
          selfMonitoringRef.current.restorePublishing = false
        }
        return
      }

      const wantsMic = voicePreferenceStore.getMicEnabled()
      const publishing = shouldUseNativeMicrophone()
        ? Boolean(nativeMicrophoneRef.current && !nativeMicrophoneMutedRef.current)
        : participantMicPublishing(room.localParticipant)

      if (active) {
        selfMonitoringRef.current.restorePublishing = wantsMic
        if (publishing) {
          if (shouldUseNativeMicrophone()) {
            void setNativeMicrophoneMuted(true).catch(() => {})
          } else {
            void room.localParticipant.setMicrophoneEnabled(false)
          }
        }
        setMicPublishing(false)
        setSelfSpeaking(false)
        setCurrentMicIssue(null)
        if (userId) patchLocalVoiceMic(activeChannelId, userId, false)
        if (status === 'connected') {
          syncVoiceFlagsToGateway(activeChannelId, true, deafenedRef.current)
        }
        syncRoomParticipants()
        return
      }

      const shouldRestorePublishing =
        selfMonitoringRef.current.restorePublishing &&
        wantsMic &&
        !deafenedRef.current
      selfMonitoringRef.current.restorePublishing = false

      if (!shouldRestorePublishing) {
        if (shouldUseNativeMicrophone()) {
          void startNativeMicrophone(room, true).catch(() => {})
        }
        setMicPublishing(false)
        setSelfSpeaking(false)
        if (userId) patchLocalVoiceMic(activeChannelId, userId, false)
        if (status === 'connected') {
          syncVoiceFlagsToGateway(activeChannelId, true, deafenedRef.current)
        }
        syncRoomParticipants()
        return
      }

      if (shouldUseNativeMicrophone()) {
        void startNativeMicrophone(room, false)
          .then((started) => {
            if (!started || !isCurrentVoiceSession(room, activeChannelId)) {
              return
            }
            if (
              selfMonitoringRef.current.active ||
              selfMonitoringRef.current.sequence !== sequence
            ) {
              void setNativeMicrophoneMuted(true).catch(() => {})
              return
            }
            setCurrentMicIssue(null)
            syncMicFromRoom(room)
            syncLocalSpeakingTrack(room)
            syncRoomParticipants()
            if (status === 'connected') {
              syncVoiceFlagsToGateway(
                activeChannelId,
                false,
                deafenedRef.current,
              )
            }
          })
          .catch((error) => {
            if (!isCurrentVoiceSession(room, activeChannelId)) {
              return
            }
            syncMicFromRoom(room, describeMicDeviceError(error))
            syncRoomParticipants()
          })
        return
      }

      void room.localParticipant
        .setMicrophoneEnabled(
          true,
          undefined,
          voiceMicPublishOptions(activeChannelAudioBitrateKbps()),
        )
        .then(() => {
          if (!isCurrentVoiceSession(room, activeChannelId)) {
            return
          }
          if (
            selfMonitoringRef.current.active ||
            selfMonitoringRef.current.sequence !== sequence
          ) {
            void room.localParticipant.setMicrophoneEnabled(false)
            return
          }
          void applyMicProcessing(room.localParticipant).then(() => {
            syncLocalSpeakingTrack(room)
          })
          setCurrentMicIssue(null)
          syncMicFromRoom(room)
          syncRoomParticipants()
          if (status === 'connected') {
            syncVoiceFlagsToGateway(
              activeChannelId,
              !participantMicPublishing(room.localParticipant),
              deafenedRef.current,
            )
          }
        })
        .catch((error) => {
          if (!isCurrentVoiceSession(room, activeChannelId)) {
            return
          }
          syncMicFromRoom(room, describeMicDeviceError(error))
          syncRoomParticipants()
        })
    },
    [
      auth.user?._id,
      activeChannelAudioBitrateKbps,
      isCurrentVoiceSession,
      setCurrentMicIssue,
      setSelfSpeaking,
      startNativeMicrophone,
      status,
      setNativeMicrophoneMuted,
      syncMicFromRoom,
      syncLocalSpeakingTrack,
      syncRoomParticipants,
      syncVoiceFlagsToGateway,
    ],
  )

  const disconnectNativeMediaForHandoff = useCallback(() => {
    nativeMicrophoneStartGenerationRef.current += 1
    nativeMicrophoneStartRef.current = null
    screenShareStartGenerationRef.current += 1
    screenShareStartingRef.current = false
    pendingScreenShareStartRef.current = null
    const activeNativeMicrophone = nativeMicrophoneRef.current
    if (activeNativeMicrophone) {
      nativeMicrophoneRef.current = null
      activeNativeMicrophone.disconnect()
    }
    nativeMicrophoneMutedRef.current = false
    selfMonitoringRef.current.restorePublishing = false
    selfMonitoringRef.current.sequence += 1

    if (nativeScreenShareRef.current) {
      void nativeScreenShareRef.current.stop().catch(() => {})
      nativeScreenShareRef.current = null
    }
    stoppedNativeScreenIdentityRef.current = null
    nativeScreenPublicationLossKeyRef.current = null
    nativeMediaEngineStatsStore.reset()

    const desktop = getSyrnikeDesktop()
    if (desktop?.platform.os === 'win32') {
      void desktop.media.cancelPendingStarts().catch(() => {})
      void desktop.media.disconnectPreparedScreenSession().catch(() => {})
    }

    setMicPublishing(false)
    setSelfSpeaking(false)
    setScreenShareEnabled(false)
    setScreenShareStarting(false)
    setCameraEnabled(false)
    dispatchNativeMedia({ type: 'reset' })
  }, [setSelfSpeaking])

  const attachAudio = useCallback(
    (room: Room) => {
      const removeDetachedElement = (element: Element) => {
        element.remove()
      }

      const playTrack = (
        track: Track,
        publication: RemoteTrackPublication,
        participant: RemoteParticipant,
      ) => {
        if (track.kind !== Track.Kind.Audio) return
        const audioTrack = track as AudioTrackWithMedia
        if (
          isDesktopNativeVoiceIdentity(participant.identity) &&
          baseVoiceIdentity(participant.identity) === auth.user?._id
        ) {
          track.detach().forEach(removeDetachedElement)
          return
        }
        track.detach().forEach(removeDetachedElement)
        const sourceElement = track.attach() as HTMLAudioElement
        sourceElement.dataset.syrnikeRemoteAudioMixer = 'source'
        sourceElement.muted = true
        sourceElement.volume = 0
        sourceElement.autoplay = true
        sourceElement.style.display = 'none'
        document.body.appendChild(sourceElement)
        void sourceElement.play().catch(() => {})
        const mediaStreamTrack = audioTrack.mediaStreamTrack
        if (!mediaStreamTrack) {
          console.error('[voice-audio-mixer] missing remote audio media track', {
            userId: baseVoiceIdentity(participant.identity),
            publicationTrackSid: publication.trackSid,
          })
          return
        }
        const added = remoteAudioMixerRef.current?.addTrack({
          trackId: remoteAudioTrackId(track, publication),
          userId: baseVoiceIdentity(participant.identity),
          source: audioSourceFromPublication(publication),
          mediaStreamTrack,
        })
        if (!added) {
          console.error('[voice-audio-mixer] failed to add remote audio track', {
            userId: baseVoiceIdentity(participant.identity),
            publicationTrackSid: publication.trackSid,
            mediaStreamTrackId: mediaStreamTrack.id,
          })
        }
        applyRemoteAudio(deafenedRef.current)
      }

      const onParticipantsChanged = () => {
        setParticipantCount(room.numParticipants)
        syncRoomParticipants()
        runVoiceRecovery('participants_changed')
      }
      const onLocalParticipantsChanged = () => {
        syncLocalSpeakingTrack(room)
        onParticipantsChanged()
      }
      const onRemoteParticipantDisconnected = (
        participant: RemoteParticipant,
      ) => {
        const screen = nativeMediaStateRef.current.screen
        if (
          stoppedNativeScreenIdentityRef.current !== participant.identity &&
          isCurrentNativeScreenParticipant(screen, participant.identity)
        ) {
          nativeScreenPublicationLostRef.current?.({
            reason: 'participant-disconnected',
            participantIdentity: participant.identity,
            publicationSid: screen.publicationSid,
            remoteParticipants: room.remoteParticipants.size,
          })
        }
        onParticipantsChanged()
      }
      const onRemoteTrackUnpublished = (
        publication: RemoteTrackPublication,
        participant: RemoteParticipant,
      ) => {
        const screen = nativeMediaStateRef.current.screen
        if (
          stoppedNativeScreenIdentityRef.current !== participant.identity &&
          publication.source === Track.Source.ScreenShare &&
          isCurrentNativeScreenPublication(
            screen,
            participant.identity,
            publication,
          )
        ) {
          nativeScreenPublicationLostRef.current?.({
            reason: 'track-unpublished',
            participantIdentity: participant.identity,
            publicationSid: remotePublicationSid(publication),
            remoteParticipants: room.remoteParticipants.size,
          })
        }
        onParticipantsChanged()
      }

      room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (participant.isLocal) return
        if (
          publication.source === Track.Source.ScreenShare ||
          publication.source === Track.Source.ScreenShareAudio
        ) {
          const subscribed = applyRemoteScreenParticipantSubscription(participant)
          if (!subscribed) {
            publication.setSubscribed?.(false)
            track.detach().forEach(removeDetachedElement)
            onParticipantsChanged()
            return
          }
        }
        if (track.kind === Track.Kind.Audio) {
          playTrack(track, publication, participant)
          return
        }
        onParticipantsChanged()
      })

      room.on(RoomEvent.TrackUnsubscribed, (track, publication) => {
        if (track.kind === Track.Kind.Audio) {
          remoteAudioMixerRef.current?.removeTrack(
            remoteAudioTrackId(track, publication),
          )
          const mediaStreamTrack = (track as AudioTrackWithMedia).mediaStreamTrack
          if (mediaStreamTrack) {
            remoteAudioMixerRef.current?.removeMediaStreamTrack(mediaStreamTrack)
          }
        }
        track.detach().forEach(removeDetachedElement)
        onParticipantsChanged()
      })

      room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
        const soundEvent = screenViewerSoundEventFromData({
          payload,
          topic,
          senderIdentity: participant?.identity,
          currentUserId: authUserIdRef.current,
        })
        if (soundEvent) playUiSound(soundEvent)
      })

      room.on(RoomEvent.ParticipantConnected, onParticipantsChanged)
      room.on(RoomEvent.ParticipantDisconnected, onRemoteParticipantDisconnected)
      room.on(RoomEvent.LocalTrackPublished, onLocalParticipantsChanged)
      room.on(RoomEvent.LocalTrackUnpublished, onLocalParticipantsChanged)
      room.on(RoomEvent.TrackPublished, (_publication, participant) => {
        if (!participant.isLocal) {
          applyRemoteScreenParticipantSubscription(participant)
        }
        onParticipantsChanged()
      })
      room.on(RoomEvent.TrackUnpublished, onRemoteTrackUnpublished)
      room.on(RoomEvent.TrackMuted, (_publication, participant) => {
        if (participant.isLocal) {
          syncLocalSpeakingTrack(room)
        }
        onParticipantsChanged()
      })
      room.on(RoomEvent.TrackUnmuted, (_publication, participant) => {
        if (participant.isLocal) {
          syncLocalSpeakingTrack(room)
        }
        onParticipantsChanged()
      })

      room.on(RoomEvent.Connected, () => {
        if (!channelIdRef.current) return
        statusRef.current = 'connected'
        voiceConnectedAtRef.current = Date.now()
        setStatus('connected')
        playUiSound('voice.user_join')
        onParticipantsChanged()
      })

      room.on(RoomEvent.MediaDevicesError, (error, kind) => {
        if (kind !== 'audioinput') return
        syncMicFromRoom(room, describeMicDeviceError(error))
      })

      room.on(RoomEvent.Disconnected, () => {
        if (roomRef.current !== room) {
          room.removeAllListeners()
          return
        }

        const intent = disconnectIntentRef.current
        if (intent === 'switch' || intent === 'leave' || intent === 'cleanup') {
          disconnectIntentRef.current = 'none'
          return
        }

        const targetChannelId = channelIdRef.current
        if (!targetChannelId) {
          abortJoinAttempt()
          return
        }

        const activeRoom = roomRef.current
        if (activeRoom) {
          activeRoom.removeAllListeners()
          roomRef.current = null
        }
        const activeOperationId =
          voiceSessionControllerRef.current.getState().activeOperationId
        if (activeOperationId) {
          voiceSessionControllerRef.current.handleRoomDisconnected({
            operationId: activeOperationId,
            expected: false,
            error: 'Room disconnected',
          })
        }
        logVoiceDebugAgent({
          hypothesis: 'H7-unexpected-room-disconnect-native-media',
          event: 'voice-room-unexpected-disconnected',
          targetChannelId,
          activeOperationId,
          hadNativeScreenShare: Boolean(nativeScreenShareRef.current),
          nativeScreenState: nativeMediaStateRef.current.screen.status,
        })
        disconnectNativeMediaForHandoff()
        cleanupAudio()
        setStatus('connecting')
        setConnectionPhase('reconnecting')
        setLocalVoiceReady(false)
        voiceRejoinRef.current.onUnexpectedDisconnect(targetChannelId)
      })

      onParticipantsChanged()
    },
    [
      abortJoinAttempt,
      auth.user?._id,
      cleanupAudio,
      disconnectNativeMediaForHandoff,
      applyRemoteScreenParticipantSubscription,
      syncMicFromRoom,
      syncLocalSpeakingTrack,
      syncRoomParticipants,
      runVoiceRecovery,
    ],
  )

  const finalizePendingVoiceMove = useCallback(
    (operationId: string) => {
      const pending = pendingReplacedVoiceRoomRef.current
      if (!pending || pending.operationId !== operationId) return
      disconnectIntentRef.current = 'switch'
      pending.room.removeAllListeners()
      void pending.room.disconnect().catch(() => {})
      if (roomRef.current === pending.room) {
        roomRef.current = null
      }
      pendingReplacedVoiceRoomRef.current = null
      if (disconnectIntentRef.current === 'switch') {
        disconnectIntentRef.current = 'none'
      }
    },
    [],
  )

  const disconnectReplacedVoiceSession = useCallback(
    async (session: ActiveVoiceSessionSnapshot) => {
      const controllerState = voiceSessionControllerRef.current.getState()
      const operationId = controllerState.activeOperationId
      if (!operationId) return

      disconnectNativeMediaForHandoff()
      pendingReplacedVoiceRoomRef.current = {
        operationId,
        room: session.room,
        channelId: session.channelId,
        localVoiceReady: session.localVoiceReady,
      }
      if (controllerState.phase === 'connected') {
        finalizePendingVoiceMove(operationId)
      }
    },
    [disconnectNativeMediaForHandoff, finalizePendingVoiceMove],
  )

  const disconnectSupersededTargetRoom = useCallback(() => {
    const source = pendingReplacedVoiceRoomRef.current
    const targetRoom = roomRef.current
    if (!source || !targetRoom || targetRoom === source.room) return

    disconnectNativeMediaForHandoff()
    disconnectIntentRef.current = 'switch'
    targetRoom.removeAllListeners()
    void targetRoom.disconnect().catch(() => {})
    roomRef.current = source.room
    if (disconnectIntentRef.current === 'switch') {
      disconnectIntentRef.current = 'none'
    }
  }, [disconnectNativeMediaForHandoff])

  const restorePreviousVoiceSession = useCallback(
    (
      session: ActiveVoiceSessionSnapshot,
      failedTargetChannelId: string,
    ) => {
      pendingReplacedVoiceRoomRef.current = null
      const userId = auth.user?._id ?? session.room.localParticipant.identity
      if (userId) {
        syncStore.removeVoiceParticipant(failedTargetChannelId, userId)
      }
      roomRef.current = session.room
      setChannelId(session.channelId)
      statusRef.current = 'connected'
      setStatus('connected')
      setConnectionPhase('connected')
      setLocalVoiceReady(session.localVoiceReady)
      syncRoomParticipants()
    },
    [auth.user?._id, syncRoomParticipants],
  )

  const restorePendingVoiceMoveToSource = useCallback(
    (targetChannelId: string) => {
      const pendingSource = pendingReplacedVoiceRoomRef.current
      const controllerState = voiceSessionControllerRef.current.getState()
      const source =
        pendingSource?.channelId === targetChannelId
          ? pendingSource
          : !pendingSource &&
              controllerState.previousChannelId === targetChannelId &&
              statusRef.current === 'connecting' &&
              roomRef.current
            ? {
                operationId: controllerState.activeOperationId,
                room: roomRef.current,
                channelId: targetChannelId,
                localVoiceReady: true,
              }
            : null

      if (!source?.operationId) return false

      rememberCanceledVoiceOperation(source.operationId)
      disconnectSupersededTargetRoom()
      pendingReplacedVoiceRoomRef.current = null
      joinInFlightRef.current = null

      const userId = auth.user?._id ?? source.room.localParticipant.identity
      const currentVisualChannelId = channelIdRef.current
      if (
        userId &&
        currentVisualChannelId &&
        currentVisualChannelId !== source.channelId
      ) {
        syncStore.removeVoiceParticipant(currentVisualChannelId, userId)
      }

      voiceSessionControllerRef.current.restorePreviousSession(source.channelId)
      roomRef.current = source.room
      setChannelId(source.channelId)
      statusRef.current = 'connected'
      setStatus('connected')
      setConnectionPhase('connected')
      setLocalVoiceReady(source.localVoiceReady)
      syncRoomParticipants()
      return true
    },
    [auth.user?._id, disconnectSupersededTargetRoom, syncRoomParticipants],
  )

  const dropPreviousVoiceSession = useCallback(
    async (
      session: ActiveVoiceSessionSnapshot,
      failedTargetChannelId: string,
    ) => {
      const activeOperationId =
        voiceSessionControllerRef.current.getState().activeOperationId
      rememberCanceledVoiceOperation(activeOperationId)
      disconnectPendingReplacedVoiceRoom()
      const leaveOperationId = voiceSessionControllerRef.current.requestLeave()
      const userId = auth.user?._id ?? session.room.localParticipant.identity
      const targetRoom = roomRef.current

      if (targetRoom && targetRoom !== session.room) {
        disconnectIntentRef.current = 'switch'
        targetRoom.removeAllListeners()
        void targetRoom.disconnect().catch(() => {})
      }

      disconnectIntentRef.current = 'leave'
      session.room.removeAllListeners()
      await session.room.disconnect().catch(() => {})
      if (roomRef.current === session.room || roomRef.current === targetRoom) {
        roomRef.current = null
      }

      cleanupAudio()
      clearSessionVoiceGateThreshold()
      resetVoiceState()
      if (auth.gatewayState === 'connected') {
        requestVoiceLeave()
      }
      if (userId) {
        syncStore.removeVoiceParticipant(failedTargetChannelId, userId)
        syncStore.removeVoiceParticipant(session.channelId, userId)
      }
      voiceSessionControllerRef.current.handleRoomDisconnected({
        operationId: leaveOperationId,
        expected: true,
      })
      disconnectIntentRef.current = 'none'
    },
    [
      auth.gatewayState,
      auth.user?._id,
      cleanupAudio,
      disconnectPendingReplacedVoiceRoom,
      resetVoiceState,
    ],
  )

  useEffect(() => {
    voiceJoinDepsRef.current = {
      getToken: () => auth.session?.token,
      getLocalUserId: () => auth.user?._id,
      isJoinBlocked: () => {
        const now = Date.now()
        return (
          voiceTransitionBlockedUntil(voiceTransitionAttemptsRef.current, now) >
          now
        )
      },
      getActiveSession: () => {
        const pendingSource = pendingReplacedVoiceRoomRef.current
        if (pendingSource) {
          return {
            room: pendingSource.room,
            channelId: pendingSource.channelId,
            localVoiceReady: pendingSource.localVoiceReady,
          }
        }

        const room = roomRef.current
        const controllerState = voiceSessionControllerRef.current.getState()
        const activeChannelId =
          statusRef.current === 'connected'
            ? channelIdRef.current
            : controllerState.previousChannelId
        if (
          !room ||
          !activeChannelId ||
          (statusRef.current !== 'connected' &&
            statusRef.current !== 'connecting')
        ) {
          return null
        }
        return {
          room,
          channelId: activeChannelId,
          localVoiceReady:
            statusRef.current === 'connected' ? localVoiceReady : false,
        }
      },
      requestJoinOperation: (channelId, reason) =>
        voiceSessionControllerRef.current.requestJoin(channelId, { reason }),
      handleServerPrepareSucceeded: (operationId) =>
        voiceSessionControllerRef.current.handleServerPrepareSucceeded(
          operationId,
        ),
      handleRoomConnected: (operationId) =>
        voiceSessionControllerRef.current.handleRoomConnected(operationId),
      handleRoomConnectFailed: (operationId, error) =>
        voiceSessionControllerRef.current.handleRoomConnectFailed(
          operationId,
          error,
        ),
      isCurrentJoinOperation: (operationId) =>
        voiceSessionControllerRef.current.getState().activeOperationId ===
        operationId,
      beginConnecting: (targetChannelId, preview) => {
        const previousVisualChannelId = channelIdRef.current
        const localUserId = auth.user?._id
        if (
          localUserId &&
          previousVisualChannelId &&
          previousVisualChannelId !== targetChannelId
        ) {
          syncStore.removeVoiceParticipant(previousVisualChannelId, localUserId)
        }
        setStatus('connecting')
        setLocalVoiceReady(false)
        setChannelId(targetChannelId)
        restoreVoicePreferences()
        for (const participant of preview) {
          syncStore.addVoiceParticipant(targetChannelId, participant)
        }
      },
      setActiveRoom: (room) => {
        roomRef.current = room
      },
      disconnectReplacedSession: disconnectReplacedVoiceSession,
      restorePreviousSession: restorePreviousVoiceSession,
      dropPreviousSession: dropPreviousVoiceSession,
      attachRoomHandlers: (room) => attachAudio(room),
      setLiveKitCredentials: (credentials) => {
        liveKitCredentialsRef.current = credentials
        const desktop = getSyrnikeDesktop()
        if (desktop?.platform.os === 'win32') {
          void desktop.media.prepareScreenSession({ livekit: credentials.screen }).catch(() => {})
        }
      },
      setConnectionPhase,
      onRoomConnected: (room, targetChannelId) => {
        setLocalVoiceReady(false)
        statusRef.current = 'connected'
        voiceConnectedAtRef.current = Date.now()
        setStatus('connected')
        syncStore.clearVoiceCallDismissal(targetChannelId)
        syncRoomParticipants()
        void finishLocalVoiceSetup(room, targetChannelId)
      },
      onJoinSuccess: () => voiceRejoinRef.current.cancel(),
      abortJoin: abortJoinAttempt,
    }
  }, [
    abortJoinAttempt,
    attachAudio,
    auth.session?.token,
    auth.user?._id,
    disconnectReplacedVoiceSession,
    dropPreviousVoiceSession,
    finishLocalVoiceSetup,
    localVoiceReady,
    restoreVoicePreferences,
    restorePreviousVoiceSession,
    syncRoomParticipants,
  ])

  useEffect(() => {
    voiceRejoinDepsRef.current = {
      attemptRejoin: (channelId) =>
        performVoiceJoinRef.current(channelId, { rejoin: true }),
      onGiveUp: abortJoinAttempt,
      isGatewayConnected: () => auth.gatewayState === 'connected',
      shouldKeepTrying: (channelId) =>
        Boolean(auth.session?.token) &&
        canJoinVoiceChannel(syncStore.getState().channels[channelId]),
    }
  }, [abortJoinAttempt, auth.gatewayState, auth.session?.token])

  useEffect(() => {
    const unsubscribe = eventsGateway.subscribeState((state) => {
      if (state !== 'connected') return
      voiceRejoinRef.current.onGatewayConnected()
      runVoiceRecovery('gateway_connected')

      const activeChannelId = channelIdRef.current
      if (status !== 'connected' || !activeChannelId) return
      const { selfMute, selfDeaf } = readCurrentVoiceFlags()
      syncVoiceFlagsToGateway(
        activeChannelId,
        selfMute,
        selfDeaf,
      )
    })
    return () => {
      void unsubscribe()
    }
  }, [readCurrentVoiceFlags, runVoiceRecovery, status, syncVoiceFlagsToGateway])

  useEffect(() => {
    const unsubscribe = eventsGateway.subscribeEvents((event) => {
      if (shouldIgnoreVoiceGatewayEvent(event)) return

      const controller = voiceSessionControllerRef.current
      const supersede = localVoiceSupersedeFromGatewayEvent(
        event,
        auth.user?._id,
        channelIdRef.current,
        controller.getState().activeOperationId,
      )
      if (supersede) {
        stopRemoteSupersededVoiceSession(
          `gateway:${supersede.type}`,
          supersede.channelId,
        )
        return
      }

      const commit = voiceCommitFromGatewayEvent(event, auth.user?._id)
      if (!commit) return

      const operationId = voiceCommitOperationIdToObserve(
        controller.getState(),
        commit,
      )
      if (!operationId) return

      controller.handleServerCommitObserved(operationId, commit.channelId)
      finalizePendingVoiceMove(operationId)
    })
    return () => {
      unsubscribe()
    }
  }, [auth.user?._id, finalizePendingVoiceMove, stopRemoteSupersededVoiceSession])

  const join = useCallback(
    async (targetChannelId: string) => {
      const token = auth.session?.token
      if (!token) {
        toast.error('Нет сессии')
        return false
      }

      if (
        channelId === targetChannelId &&
        status === 'connected' &&
        roomRef.current != null
      ) {
        return true
      }

      if (restorePendingVoiceMoveToSource(targetChannelId)) {
        return true
      }

      const now = Date.now()
      if (
        voiceTransitionBlockedUntil(voiceTransitionAttemptsRef.current, now) >
        now
      ) {
        return false
      }

      const inFlight = joinInFlightRef.current
      if (inFlight?.channelId === targetChannelId) {
        return await inFlight.promise
      }

      const targetChannel = syncStore.getState().channels[targetChannelId]
      if (!canJoinVoiceChannel(targetChannel)) {
        toast.error('Голос недоступен в этом канале')
        return false
      }

      const supersededOperationId =
        voiceSessionControllerRef.current.getState().activeOperationId
      rememberCanceledVoiceOperation(supersededOperationId)

      voiceTransitionAttemptsRef.current = recordVoiceTransitionAttempt(
        voiceTransitionAttemptsRef.current,
        now,
      )
      disconnectSupersededTargetRoom()
      const promise = performVoiceJoinRef.current(targetChannelId)
      joinInFlightRef.current = { channelId: targetChannelId, promise }
      try {
        return await promise
      } finally {
        if (joinInFlightRef.current?.channelId === targetChannelId) {
          joinInFlightRef.current = null
        }
      }
    },
    [
      auth.session?.token,
      channelId,
      disconnectSupersededTargetRoom,
      restorePendingVoiceMoveToSource,
      status,
    ],
  )

  useEffect(() => {
    const room = roomRef.current
    if (room) syncStageMediaItems(room)
  }, [stageMediaFilters, syncStageMediaItems])

  useEffect(() => {
    setFocusedMediaId((current) =>
      current && stageMediaItems.some((item) => item.id === current && item.live)
        ? current
        : null,
    )
  }, [stageMediaItems])

  const stopNativeScreenShare = useCallback(async () => {
    const active = nativeScreenShareRef.current
    if (!active) return
    nativeScreenPublicationLossKeyRef.current = null
    logVoiceDebugAgent({
      hypothesis: 'H3-stage-native-screen-loss,H4-native-stop-timeout',
      event: 'web-stop-native-screen-share',
      hasNativeParticipantIdentity: Boolean(active.nativeParticipantIdentity),
    })
    nativeScreenShareRef.current = null
    screenShareStartingRef.current = false
    stoppedNativeScreenIdentityRef.current =
      active.nativeParticipantIdentity ?? null
    nativeMediaEngineStatsStore.reset()
    dispatchNativeMedia({ type: 'screen_stopped' })
    await active.stop()
  }, [])

  const handleNativeScreenPublicationLost = useCallback(
    (loss: NativeScreenPublicationLoss) => {
      const screen = nativeMediaStateRef.current.screen
      if (screen.status !== 'published') return
      if (loss.participantIdentity !== screen.participantIdentity) return
      if (loss.publicationSid && loss.publicationSid !== screen.publicationSid) {
        return
      }

      const lossKey = [
        screen.operationId,
        screen.participantIdentity,
        screen.publicationSid,
        loss.reason,
      ].join(':')
      if (nativeScreenPublicationLossKeyRef.current === lossKey) return
      nativeScreenPublicationLossKeyRef.current = lossKey

      logVoiceDebugAgent({
        hypothesis: 'H3-stage-native-screen-loss',
        event: 'native-screen-publication-lost',
        reason: loss.reason,
        participantIdentity: loss.participantIdentity,
        publicationSid: loss.publicationSid,
        remoteParticipants: loss.remoteParticipants,
      })

      if (!nativeScreenShareRef.current) {
        dispatchNativeMedia({ type: 'screen_stopped' })
        setScreenShareEnabled(false)
        syncRoomParticipants()
        toast.error('Демонстрация экрана отключилась')
        return
      }

      void stopNativeScreenShare()
        .catch((error) => {
          logVoiceDebugAgent({
            hypothesis: 'H3-stage-native-screen-loss',
            event: 'native-screen-publication-lost-stop-failed',
            reason: loss.reason,
            message: error instanceof Error ? error.message : String(error),
          })
        })
        .finally(() => {
          setScreenShareEnabled(false)
          syncRoomParticipants()
          toast.error('Демонстрация экрана отключилась')
        })
    },
    [stopNativeScreenShare, syncRoomParticipants],
  )

  useEffect(() => {
    nativeScreenPublicationLostRef.current = handleNativeScreenPublicationLost
    return () => {
      if (
        nativeScreenPublicationLostRef.current === handleNativeScreenPublicationLost
      ) {
        nativeScreenPublicationLostRef.current = null
      }
    }
  }, [handleNativeScreenPublicationLost])

  const requestStageMediaFocus = useCallback((mediaId: string) => {
    setFocusedMediaId(mediaId)
    setStageFocusNonce((current) => current + 1)
  }, [])

  const watchParticipantScreenShare = useCallback(
    async (targetChannelId: string, userId: string) => {
      const mediaId = stageMediaItemId(userId, 'screen')
      const localUserId = auth.user?._id
      const isLocal = isVoiceLocalUserId(userId, localUserId)
      const wasWatching = watchedRemoteScreenIdsRef.current.has(mediaId)

      if (!isLocal) {
        pendingScreenWatchIdsRef.current.add(mediaId)
        watchedRemoteScreenIdsRef.current.add(mediaId)
      }

      if (!isVoiceConnectedInChannel({ channelId, status }, targetChannelId)) {
        await join(targetChannelId)
      }

      if (!isLocal) {
        pendingScreenWatchIdsRef.current.add(mediaId)
        watchedRemoteScreenIdsRef.current.add(mediaId)
      }

      const room = roomRef.current
      if (room && !isLocal) {
        for (const participant of room.remoteParticipants.values()) {
          if (baseVoiceIdentity(participant.identity) !== userId) continue
          applyRemoteScreenParticipantSubscription(participant, true)
        }
        if (!wasWatching) {
          void publishScreenViewerSound(room, userId, 'join')
        }
        syncStageMediaItems(room)
      }

      requestStageMediaFocus(mediaId)
    },
    [
      applyRemoteScreenParticipantSubscription,
      auth.user?._id,
      channelId,
      join,
      publishScreenViewerSound,
      requestStageMediaFocus,
      status,
      syncStageMediaItems,
    ],
  )

  const setStageMediaSubscribed = useCallback(
    (mediaId: string, subscribed: boolean) => {
      const room = roomRef.current
      if (!room) return
      const item = stageMediaItemsRef.current.find(
        (stageItem) => stageItem.id === mediaId,
      )
      const currentUserIds = new Set<string>()
      if (auth.user?._id) currentUserIds.add(auth.user._id)
      currentUserIds.add(baseVoiceIdentity(room.localParticipant.identity))
      const target = resolveStageScreenSubscriptionTarget(
        item,
        mediaId,
        currentUserIds,
      )
      if (!target) return
      const wasWatching = watchedRemoteScreenIdsRef.current.has(target.mediaId)

      const action = item
        ? setStageScreenSubscription(item, subscribed)
        : target.isLocal && !subscribed
          ? 'stop-local-screen'
          : 'none'

      if (!target.isLocal) {
        setRemoteScreenWatchIntent(
          watchedRemoteScreenIdsRef.current,
          pendingScreenWatchIdsRef.current,
          target.mediaId,
          subscribed,
        )
        for (const participant of room.remoteParticipants.values()) {
          if (baseVoiceIdentity(participant.identity) !== target.userId) continue
          applyRemoteScreenParticipantSubscription(participant, subscribed)
        }
        if (wasWatching !== subscribed) {
          void publishScreenViewerSound(
            room,
            target.userId,
            subscribed ? 'join' : 'leave',
          )
        }

        syncStageMediaItems(room)
        return
      }

      if (action === 'stop-local-screen') {
        if (nativeScreenShareRef.current) {
          void stopNativeScreenShare()
            .then(() => {
              setScreenShareEnabled(false)
              syncRoomParticipants()
            })
            .catch((error) => {
              toast.error(
                error instanceof Error
                  ? error.message
                  : 'Не удалось остановить демонстрацию',
              )
            })
          return
        }

        void room.localParticipant
          .setScreenShareEnabled(false)
          .then(() => {
            setScreenShareEnabled(false)
            syncRoomParticipants()
          })
          .catch((error) => {
            toast.error(
              error instanceof Error
                ? error.message
                : 'Не удалось остановить демонстрацию',
            )
          })
        return
      }

      if (action === 'none') {
        syncStageMediaItems(room)
      }
    },
    [
      applyRemoteScreenParticipantSubscription,
      auth.user?._id,
      publishScreenViewerSound,
      stopNativeScreenShare,
      syncRoomParticipants,
      syncStageMediaItems,
    ],
  )

  const toggleCamera = useCallback(() => {
    const room = roomRef.current
    if (!room) return
    const next = !localParticipantVoiceFlags(room.localParticipant).camera
    void room.localParticipant
      .setCameraEnabled(next)
      .then(() => {
        setCameraEnabled(next)
        playUiSound(next ? 'camera.started' : 'camera.stopped')
        syncRoomParticipants()
      })
      .catch((error) => {
        toast.error(
          error instanceof Error
            ? error.message
            : 'Не удалось переключить камеру',
        )
      })
  }, [syncRoomParticipants])

  const startBrowserScreenShare = useCallback(
    async (
      room: Room,
      quality: ScreenShareQualityName,
      withAudio: boolean,
      limits?: ScreenShareCaptureLimits,
    ) => {
      const capture = screenShareCaptureOptions(quality, limits)
      const publication = await room.localParticipant.setScreenShareEnabled(
        true,
        {
          ...capture.capture,
          audio: screenShareAudioCaptureOptions(withAudio),
        },
        withAudio
          ? screenShareCombinedPublishOptions(
              quality,
              activeChannelAudioBitrateKbps(),
              limits,
            )
          : capture.publish,
      )
      if (publication) {
        ;(publication as VoiceStageMediaPublication).options = {
          videoCodec: capture.publish.videoCodec,
          simulcast: capture.publish.simulcast,
          degradationPreference: capture.publish.degradationPreference,
          screenShareEncoding: capture.publish.screenShareEncoding,
        }
      }

      nativeMediaEngineStatsStore.setChromium()

      const videoTrack = publication?.videoTrack
      if (videoTrack?.mediaStreamTrack) {
        videoTrack.mediaStreamTrack.contentHint = capture.capture.contentHint
        await tuneScreenShareAfterPublish(
          room,
          videoTrack.mediaStreamTrack,
          quality,
          limits,
        )
      }

      videoTrack?.on('ended', () => {
        void room.localParticipant.setScreenShareEnabled(false).then(() => {
          setScreenShareEnabled(
            localParticipantVoiceFlags(room.localParticipant).screensharing,
          )
          playUiSound('screen_share.stopped')
          syncRoomParticipants()
        })
      })
    },
    [activeChannelAudioBitrateKbps, syncRoomParticipants],
  )

  const startLocalScreenShare = useCallback(
    async (quality: ScreenShareQualityName, withAudio: boolean) => {
      const room = roomRef.current
      if (!room) return
      const targetChannelId = channelIdRef.current
      if (!targetChannelId) return
      if (!isCurrentVoiceSession(room, targetChannelId)) return
      if (screenShareStartingRef.current || nativeScreenShareRef.current) return
      if (!localVoiceReadyRef.current) {
        pendingScreenShareStartRef.current = { quality, withAudio }
        logVoiceDebugAgent({
          hypothesis: 'H6-screen-start-before-local-voice-ready',
          event: 'screen-start-deferred-local-voice-not-ready',
          voiceStatus: statusRef.current,
          roomState: room.state,
        })
        return
      }
      const startGeneration = screenShareStartGenerationRef.current + 1
      screenShareStartGenerationRef.current = startGeneration
      const requestId = crypto.randomUUID()
      const debugStartedAt = performance.now()
      screenShareDebugUntilRef.current = Date.now() + 30_000
      setScreenShareDebugRun((run) => run + 1)
      const screenOperationId =
        voiceSessionControllerRef.current.getState().activeOperationId ??
        `screen:${startGeneration}`
      const isCurrentScreenShareStart = () =>
        screenShareStartGenerationRef.current === startGeneration &&
        isCurrentVoiceSession(room, targetChannelId)
      const clearCurrentScreenShareStart = () => {
        if (screenShareStartGenerationRef.current !== startGeneration) return
        screenShareStartingRef.current = false
        setScreenShareStarting(false)
      }

      voicePreferenceStore.setScreenShareQuality(quality)
      voicePreferenceStore.setScreenShareAudio(withAudio)
      screenShareStartingRef.current = true
      setScreenShareStarting(true)

      const prefs = readVoicePreferences()
      const desktop = getSyrnikeDesktop()
      const useNative = shouldUseNativeScreenShare(prefs.screenShareCaptureMode)
      const screenShareLimits = await resolveScreenShareCaptureLimits()
      logVoiceDebugAgent({
        hypothesis: 'H1-screen-start-lifecycle',
        event: 'screen-start-requested',
        elapsedMs: 0,
        quality,
        withAudio,
        requestedNative: useNative,
        useNative: Boolean(useNative && desktop),
        hasDesktopRuntime: Boolean(desktop),
        voiceStatus: statusRef.current,
        roomState: room.state,
        limits: screenShareLimits,
      })

      try {
        if (useNative && desktop) {
          dispatchNativeMedia({
            type: 'screen_start_requested',
            operationId: screenOperationId,
            channelId: targetChannelId,
            requestId,
          })
          stoppedNativeScreenIdentityRef.current = null
          nativeScreenPublicationLossKeyRef.current = null
          const pickerPromise = waitForNativePickerSelection()
          await desktop.media.openDisplayPicker(withAudio)
          const selection = await pickerPromise
          logVoiceDebugAgent({
            hypothesis: 'H1-screen-start-lifecycle',
            event: 'native-picker-selected',
            elapsedMs: Math.round(performance.now() - debugStartedAt),
            audioRequested: selection.audioRequested,
          })
          if (!isCurrentScreenShareStart()) {
            clearCurrentScreenShareStart()
            void desktop.media.cancelPendingStarts('screen').catch(() => {})
            void desktop.media.disconnectPreparedScreenSession().catch(() => {})
            return
          }
          voicePreferenceStore.setScreenShareAudio(selection.audioRequested)
          const handleSidecarLost = (message: string) => {
            console.warn('[voice] native media engine lost', message)
            toast.error('Нативный захват прерван')
            dispatchNativeMedia({
              type: 'screen_failed',
              operationId: screenOperationId,
              channelId: targetChannelId,
              error: message,
            })
            void stopNativeScreenShare().catch(() => {})
            setScreenShareEnabled(false)
            syncRoomParticipants()
          }
          let session: NativeScreenShareSession | null = null
          const handleNativeScreenEnded = () => {
            const active = nativeScreenShareRef.current
            if (!active || active !== session) return
            nativeScreenShareRef.current = null
            stoppedNativeScreenIdentityRef.current =
              active.nativeParticipantIdentity ?? null
            nativeMediaEngineStatsStore.reset()
            dispatchNativeMedia({ type: 'screen_stopped' })
            setScreenShareEnabled(false)
            clearCurrentScreenShareStart()
            syncRoomParticipants()
          }
          const startNative = async (forceRefresh: boolean) => {
            if (!isCurrentScreenShareStart()) {
              return null
            }
            return publishNativeScreenShare(
              room,
              room.localParticipant,
              selection.sourceId,
              requestId,
              quality,
              selection.audioRequested,
              activeChannelAudioBitrateKbps(),
              handleSidecarLost,
              handleNativeScreenEnded,
              await refreshNativeLiveKitCredentials('screen', forceRefresh),
              screenShareLimits,
            )
          }

          try {
            session = await startNative(false)
          } catch (error) {
            if (!isLiveKitTokenFailure(error)) throw error
            await stopNativeScreenShare()
            session = await startNative(true)
          }
          if (!session) {
            throw new Error('Native screen share did not start')
          }
          logVoiceDebugAgent({
            hypothesis: 'H1-screen-start-lifecycle',
            event: 'native-session-started',
            elapsedMs: Math.round(performance.now() - debugStartedAt),
            width: session.width,
            height: session.height,
            fps: session.fps,
            bitrate: session.bitrate,
            hasAudio: Boolean(session.audio),
            hasNativeParticipantIdentity: Boolean(
              session.nativeParticipantIdentity,
            ),
          })
          if (!isCurrentScreenShareStart()) {
            await session.stop().catch(() => {})
            return
          }
          nativeScreenShareRef.current = session
          const publicationOptions = {
            userId: auth.user?._id,
            nativeParticipantIdentity: session.nativeParticipantIdentity,
          }
          const observedPublication =
            findNativeScreenPublication(room, publicationOptions) ??
            (await waitForNativeScreenPublication(
              room,
              publicationOptions,
              10_000,
            ))
          if (!isCurrentScreenShareStart()) {
            await session.stop().catch(() => {})
            return
          }
          dispatchNativeMedia({
            type: 'screen_publication_observed',
            operationId: screenOperationId,
            channelId: targetChannelId,
            participantIdentity: observedPublication.participantIdentity,
            publicationSid: observedPublication.publicationSid,
          })
          logVoiceDebugAgent({
            hypothesis: 'H3-remote-decode-lag',
            event: 'native-publication-observed',
            elapsedMs: Math.round(performance.now() - debugStartedAt),
            hasParticipantIdentity: Boolean(
              observedPublication.participantIdentity,
            ),
            hasPublicationSid: Boolean(observedPublication.publicationSid),
          })
          setScreenShareEnabled(true)
          playUiSound('screen_share.started')
          clearCurrentScreenShareStart()
          syncRoomParticipants()
          return
        }

        if (desktop?.platform.os === 'win32') {
          throw new Error('Нативный media engine недоступен')
        }

        await startBrowserScreenShare(room, quality, withAudio, screenShareLimits)
        logVoiceDebugAgent({
          hypothesis: 'H5-browser-sender-tuning-miss',
          event: 'browser-screen-started',
          elapsedMs: Math.round(performance.now() - debugStartedAt),
          quality,
          withAudio,
        })
        if (!isCurrentScreenShareStart()) {
          await room.localParticipant.setScreenShareEnabled(false).catch(() => {})
          clearCurrentScreenShareStart()
          return
        }
        setScreenShareEnabled(
          localParticipantVoiceFlags(room.localParticipant).screensharing,
        )
        playUiSound('screen_share.started')
        clearCurrentScreenShareStart()
        syncRoomParticipants()
      } catch (error) {
        if (!isCurrentScreenShareStart()) {
          return
        }
        logVoiceDebugAgent({
          hypothesis: 'H1-screen-start-lifecycle',
          event: 'screen-start-failed',
          elapsedMs: Math.round(performance.now() - debugStartedAt),
          message: error instanceof Error ? error.message : String(error),
          useNative: Boolean(useNative && desktop),
        })
        clearCurrentScreenShareStart()
        dispatchNativeMedia({
          type: 'screen_failed',
          operationId: screenOperationId,
          channelId: targetChannelId,
          error: error instanceof Error ? error.message : String(error),
        })
        if (desktop?.platform.os === 'win32') {
          await desktop.media.cancelPendingStarts('screen').catch(() => {})
          await stopNativeScreenShare().catch(() => {})
          clearNativePickerSelection()
        }
        rejectNativePickerSelection(
          error instanceof Error
            ? error
            : new Error('Не удалось начать демонстрацию экрана'),
        )
        toast.error(
          error instanceof Error
            ? error.message
            : 'Не удалось начать демонстрацию экрана',
        )
      }
    },
    [
      refreshNativeLiveKitCredentials,
      activeChannelAudioBitrateKbps,
      auth.user?._id,
      isCurrentVoiceSession,
      startBrowserScreenShare,
      stopNativeScreenShare,
      syncRoomParticipants,
    ],
  )

  useEffect(() => {
    if (status !== 'connected' || !localVoiceReady) return
    if (screenShareStartingRef.current || nativeScreenShareRef.current) return
    const pending = pendingScreenShareStartRef.current
    if (!pending) return
    pendingScreenShareStartRef.current = null
    logVoiceDebugAgent({
      hypothesis: 'H6-screen-start-before-local-voice-ready',
      event: 'screen-start-resumed-after-local-voice-ready',
    })
    void startLocalScreenShare(pending.quality, pending.withAudio)
  }, [localVoiceReady, startLocalScreenShare, status])

  const toggleScreenShare = useCallback(() => {
    const room = roomRef.current
    if (!room) return
    if (screenShareStarting) return
    if (pendingScreenShareStartRef.current) {
      pendingScreenShareStartRef.current = null
      return
    }

    if (room.localParticipant.isScreenShareEnabled || nativeScreenShareRef.current) {
      if (nativeScreenShareRef.current) {
        void stopNativeScreenShare()
          .then(() => {
            setScreenShareEnabled(false)
            playUiSound('screen_share.stopped')
            syncRoomParticipants()
          })
          .catch((error) => {
            toast.error(
              error instanceof Error
                ? error.message
                : 'Не удалось остановить демонстрацию',
            )
          })
        return
      }

      void room.localParticipant
        .setScreenShareEnabled(false)
        .then(() => {
          setScreenShareEnabled(false)
          playUiSound('screen_share.stopped')
          syncRoomParticipants()
        })
        .catch((error) => {
          toast.error(
            error instanceof Error
              ? error.message
              : 'Не удалось остановить демонстрацию',
          )
        })
      return
    }

    const prefs = readVoicePreferences()
    void startLocalScreenShare(prefs.screenShareQuality, prefs.screenShareAudio)
  }, [
    screenShareStarting,
    startLocalScreenShare,
    stopNativeScreenShare,
    syncRoomParticipants,
  ])

  const toggleStageFullscreen = useCallback(() => {
    setStageFullscreen((value) => !value)
  }, [])

  const toggleMic = useCallback(() => {
    const room = roomRef.current
    const activeChannelId = channelIdRef.current
    const userId = auth.user?._id
    const nextMic = !voicePreferenceStore.getMicEnabled()
    voicePreferenceStore.setMicEnabled(nextMic)
    playUiSound(nextMic ? 'voice.unmute' : 'voice.mute')
    setMicEnabled(nextMic)
    if (!nextMic) {
      setCurrentMicIssue(null)
    }

    const wasDeafened = deafenedRef.current
    if (nextMic && wasDeafened) {
      voicePreferenceStore.setDeafened(false)
      setDeafened(false)
      deafenedRef.current = false
      applyRemoteAudio(false)
      if (activeChannelId && userId) {
        patchLocalVoiceDeafen(activeChannelId, userId, false)
      }
    }

    if (room) {
      if (shouldUseNativeMicrophone()) {
        if (nextMic) {
          if (selfMonitoringRef.current.active) {
            selfMonitoringRef.current.restorePublishing = true
            void startNativeMicrophone(room, true).catch((error) => {
              if (!isCurrentVoiceSession(room, activeChannelId)) {
                return
              }
              syncMicFromRoom(room, describeMicDeviceError(error))
              syncRoomParticipants()
            })
            setMicPublishing(false)
            setSelfSpeaking(false)
            setCurrentMicIssue(null)
            if (activeChannelId && userId) {
              patchLocalVoiceMic(activeChannelId, userId, false)
              if (status === 'connected') {
                syncVoiceFlagsToGateway(activeChannelId, true, deafenedRef.current)
              }
            }
            syncRoomParticipants()
            return
          }
          void startNativeMicrophone(room, false)
            .then((started) => {
              if (!started || !isCurrentVoiceSession(room, activeChannelId)) {
                return
              }
              syncMicFromRoom(room)
              syncRoomParticipants()
              if (activeChannelId && userId && status === 'connected') {
                const { selfMute, selfDeaf } = readCurrentVoiceFlags(room)
                syncVoiceFlagsToGateway(activeChannelId, selfMute, selfDeaf)
              }
            })
            .catch((error) => {
              if (!isCurrentVoiceSession(room, activeChannelId)) {
                return
              }
              syncMicFromRoom(room, describeMicDeviceError(error))
              syncRoomParticipants()
              if (activeChannelId && userId && status === 'connected') {
                syncVoiceFlagsToGateway(
                  activeChannelId,
                  true,
                  deafenedRef.current,
                )
              }
            })
        } else {
          selfMonitoringRef.current.restorePublishing = false
          void startNativeMicrophone(room, true).catch((error) => {
            if (!isCurrentVoiceSession(room, activeChannelId)) {
              return
            }
            syncMicFromRoom(room, describeMicDeviceError(error))
            syncRoomParticipants()
          })
          setSelfSpeaking(false)
          syncMicFromRoom(room)
          syncRoomParticipants()
          if (activeChannelId && userId && status === 'connected') {
            syncVoiceFlagsToGateway(activeChannelId, true, deafenedRef.current)
          }
        }
        return
      }
      if (!nextMic) {
        selfMonitoringRef.current.restorePublishing = false
        setSelfSpeaking(false)
      }
      void room.localParticipant
        .setMicrophoneEnabled(
          nextMic && !selfMonitoringRef.current.active,
          undefined,
          voiceMicPublishOptions(activeChannelAudioBitrateKbps()),
        )
        .then(() => {
          if (nextMic && selfMonitoringRef.current.active) {
            selfMonitoringRef.current.restorePublishing = true
            setMicPublishing(false)
            setSelfSpeaking(false)
            setCurrentMicIssue(null)
            if (activeChannelId && userId) {
              patchLocalVoiceMic(activeChannelId, userId, false)
            }
          } else {
            if (nextMic) {
              void applyMicProcessing(room.localParticipant).then(() => {
                syncLocalSpeakingTrack(room)
              })
            } else {
              syncLocalSpeakingTrack(room)
            }
            syncMicFromRoom(room)
          }
          syncRoomParticipants()
          if (activeChannelId && userId && status === 'connected') {
            const selfMute =
              nextMic && selfMonitoringRef.current.active
                ? true
                : !participantMicPublishing(room.localParticipant)
            syncVoiceFlagsToGateway(activeChannelId, selfMute, deafenedRef.current)
          }
        })
        .catch((error) => {
          syncMicFromRoom(room, describeMicDeviceError(error))
          syncRoomParticipants()
          if (activeChannelId && userId && status === 'connected') {
            syncVoiceFlagsToGateway(activeChannelId, true, deafenedRef.current)
          }
        })
      return
    }

    setMicPublishing(nextMic)
    if (activeChannelId && userId) {
      patchLocalVoiceMic(activeChannelId, userId, nextMic)
      if (status === 'connected') {
        syncVoiceFlagsToGateway(
          activeChannelId,
          !nextMic,
          deafenedRef.current,
        )
      }
    }
  }, [
    auth.user?._id,
    activeChannelAudioBitrateKbps,
    isCurrentVoiceSession,
    setCurrentMicIssue,
    setSelfSpeaking,
    readCurrentVoiceFlags,
    startNativeMicrophone,
    status,
    syncMicFromRoom,
    syncLocalSpeakingTrack,
    syncRoomParticipants,
    syncVoiceFlagsToGateway,
  ])

  const toggleDeafen = useCallback(() => {
    const room = roomRef.current
    const activeChannelId = channelIdRef.current
    const userId = auth.user?._id
    const nextDeafened = !voicePreferenceStore.getDeafened()
    voicePreferenceStore.setDeafened(nextDeafened)
    playUiSound(nextDeafened ? 'voice.deafen' : 'voice.undeafen')
    setDeafened(nextDeafened)
    deafenedRef.current = nextDeafened
    applyRemoteAudio(nextDeafened)

    if (nextDeafened) {
      voicePreferenceStore.setMicEnabled(false)
      setMicEnabled(false)
      setMicPublishing(false)
      setSelfSpeaking(false)
      setCurrentMicIssue(null)
      if (room) {
        if (shouldUseNativeMicrophone()) {
          void startNativeMicrophone(room, true).catch((error) => {
            if (!isCurrentVoiceSession(room, activeChannelId)) {
              return
            }
            syncMicFromRoom(room, describeMicDeviceError(error))
            syncRoomParticipants()
          })
        } else {
          void room.localParticipant.setMicrophoneEnabled(false)
          syncLocalSpeakingTrack(room)
        }
      }
      if (activeChannelId && userId) {
        patchLocalVoiceMic(activeChannelId, userId, false)
      }
    }

    if (activeChannelId && userId) {
      patchLocalVoiceDeafen(activeChannelId, userId, nextDeafened)
      if (status === 'connected') {
        syncVoiceFlagsToGateway(
          activeChannelId,
          nextDeafened || !voicePreferenceStore.getMicEnabled(),
          nextDeafened,
        )
      }
    }
    if (room && activeChannelId) {
      syncLocalSpeakingTrack(room)
      syncRoomParticipants()
    }
  }, [
    auth.user?._id,
    isCurrentVoiceSession,
    setCurrentMicIssue,
    setSelfSpeaking,
    startNativeMicrophone,
    status,
    syncLocalSpeakingTrack,
    syncRoomParticipants,
    syncVoiceFlagsToGateway,
  ])

  useEffect(() => {
    if (status === 'connected') {
      applyRemoteAudio(deafened)
      syncLocalSpeakingTrack()
    }
  }, [applyRemoteAudio, deafened, status, syncLocalSpeakingTrack])

  useEffect(() => {
    if (status !== 'connected' || !shouldUseNativeMicrophone()) {
      return
    }

    const desktop = getSyrnikeDesktop()
    if (!desktop) return

    return desktop.media.onMicrophoneMetrics((metrics) => {
      const active = nativeMicrophoneRef.current
      if (!active || metrics.sessionId !== active.sessionId) return
      setSelfSpeaking(
        metrics.open &&
          !nativeMicrophoneMutedRef.current &&
          !deafenedRef.current &&
          !selfMonitoringRef.current.active,
      )
    })
  }, [setSelfSpeaking, status])

  useEffect(() => {
    if (status !== 'connected') return

    runVoiceRecovery('health_tick_initial')
    const interval = window.setInterval(
      () => runVoiceRecovery('health_tick'),
      VOICE_RECOVERY_HEALTH_INTERVAL_MS,
    )
    return () => {
      window.clearInterval(interval)
    }
  }, [runVoiceRecovery, status])

  useEffect(() => {
    return voiceListenerStore.subscribe(() => {
      if (status === 'connected') {
        applyRemoteAudio(deafenedRef.current)
      }
    })
  }, [status])

  useEffect(() => {
    return voicePreferenceStore.subscribe(() => {
      const previous = lastVoicePreferencesRef.current
      const next = readVoicePreferences()
      lastVoicePreferencesRef.current = next
      if (status !== 'connected') return
      const room = roomRef.current
      if (!room) return
      const effects = voicePreferenceEffectFlags(previous, next)
      if (effects.devicesChanged) {
        void applyVoiceDevices(room).then(() => {
          if (shouldUseNativeMicrophone()) {
            configureNativeMicrophoneSession(nativeMicrophoneRef.current, next)
          } else {
            void refreshMicProcessing(room).then(() => {
              syncLocalSpeakingTrack(room)
            })
          }
        })
      } else if (effects.remoteAudioChanged) {
        applyRemoteAudio(deafenedRef.current)
      }
      if (effects.micProcessingChanged) {
        if (shouldUseNativeMicrophone()) {
          configureNativeMicrophoneSession(nativeMicrophoneRef.current, next)
        } else {
          void refreshMicProcessing(room).then(() => {
            syncLocalSpeakingTrack(room)
          })
        }
      }
    })
  }, [applyVoiceDevices, startNativeMicrophone, status, syncLocalSpeakingTrack])

  useEffect(() => {
    return () => {
      void leaveVoiceSessionRef.current('cleanup')
    }
  }, [])

  useEffect(() => {
    void resolveVoiceNodeName()
  }, [])

  useEffect(() => {
    if (status !== 'connected') {
      setVoicePingMs(null)
      setVoicePingHistory([])
      return
    }

    const room = roomRef.current
    if (!room) return

    let active = true

    async function samplePing() {
      const ping = await measureVoicePingMs(room!)
      if (!active) return
      setVoicePingMs(ping)
      if (ping != null) {
        setVoicePingHistory((history) =>
          appendVoicePingSample(history, {
            timestamp: Date.now(),
            ms: ping,
          }),
        )
      }
    }

    void samplePing()
    const interval = window.setInterval(() => void samplePing(), 2000)

    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [status])

  useEffect(() => {
    if (status !== 'connected') {
      rtcDebugSnapshotRef.current = null
      setRtcDebugSnapshot(null)
      setRtcDebugHistory([])
      return
    }
    if (!rtcDebugEnabled) return

    const room = roomRef.current
    if (!room) return

    let active = true

    async function sampleRtcDebug() {
      try {
        const current = await collectVoiceRtcDebugSnapshot(
          room!,
          stageMediaItemsRef.current as RtcDebugStageMediaItem[],
        )
        if (!active) return

        const previous = rtcDebugSnapshotRef.current
        const snapshot: RtcDebugSnapshot = previous
          ? {
              ...current,
              rates: deriveRtcRates(previous, current),
            }
          : current

        rtcDebugSnapshotRef.current = snapshot
        setRtcDebugSnapshot(snapshot)
        setRtcDebugHistory((history) =>
          appendRtcDebugSample(history, snapshot),
        )
      } catch {
        if (!active) return
        rtcDebugSnapshotRef.current = null
        setRtcDebugSnapshot(null)
      }
    }

    void sampleRtcDebug()
    const interval = window.setInterval(() => void sampleRtcDebug(), 1000)

    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [rtcDebugEnabled, status])

  useEffect(() => {
    if (status !== 'connected') return
    if (screenShareDebugRun === 0) return

    const room = roomRef.current
    if (!room) return

    let active = true
    let interval: number | null = null

    async function sampleScreenShareDebug() {
      if (Date.now() > screenShareDebugUntilRef.current) {
        if (interval != null) {
          window.clearInterval(interval)
          interval = null
        }
        return
      }
      try {
        const snapshot = await collectVoiceRtcDebugSnapshot(
          room!,
          stageMediaItemsRef.current as RtcDebugStageMediaItem[],
        )
        if (!active) return
        logVoiceDebugAgent({
          hypothesis: 'H2-bitrate-ramp,H3-remote-decode-lag',
          event: 'rtc-screen-sample',
          ...rtcDebugScreenSlice(snapshot),
        })
      } catch (error) {
        if (!active) return
        logVoiceDebugAgent({
          hypothesis: 'H2-bitrate-ramp,H3-remote-decode-lag',
          event: 'rtc-screen-sample-failed',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    void sampleScreenShareDebug()
    interval = window.setInterval(
      () => void sampleScreenShareDebug(),
      1000,
    )

    return () => {
      active = false
      if (interval != null) {
        window.clearInterval(interval)
      }
    }
  }, [screenShareDebugRun, status])

  const stageMediaItemsForUi = useMemo(
    () =>
      withConnectingLocalAvatarItem(stageMediaItems, {
        connecting: status === 'connecting' && channelId != null,
        localUserId: auth.user?._id,
        filters: stageMediaFilters,
      }),
    [
      auth.user?._id,
      channelId,
      stageMediaFilters,
      stageMediaItems,
      status,
    ],
  )

  const getNativeMicrophonePreviewTrack = useCallback(
    () => {
      return null
    },
    [],
  )

  const mediaAvailability = useMemo(
    () =>
      buildVoiceMediaAvailabilityState({
        inputDevices,
        videoDevices,
        micIssue,
      }),
    [inputDevices, micIssue, videoDevices],
  )
  const screenShareEnabledForUi =
    screenShareEnabled || isNativeScreenPublished(nativeMediaState)
  const screenShareStartingForUi =
    screenShareStarting || isNativeScreenStarting(nativeMediaState)

  const value = useMemo<VoiceContextValue>(
    () => ({
      channelId,
      status,
      connectionPhase,
      localVoiceReady,
      micEnabled,
      micPublishing,
      micIssue,
      mediaAvailability,
      deafened,
      participantCount,
      speakingUserIds,
      voicePingMs,
      voicePingHistory,
      rtcDebugEnabled,
      setRtcDebugEnabled,
      rtcDebugSnapshot,
      rtcDebugHistory,
      cameraEnabled,
      screenShareEnabled: screenShareEnabledForUi,
      screenShareStarting: screenShareStartingForUi,
      stageMediaItems: stageMediaItemsForUi,
      focusedMediaId,
      stageFocusNonce,
      join,
      leave,
      setFocusedMediaId,
      watchParticipantScreenShare,
      stageMediaFilters,
      setStageMediaFilters,
      setStageMediaSubscribed,
      stageFullscreen,
      toggleMic,
      toggleStageFullscreen,
      toggleDeafen,
      toggleCamera,
      toggleScreenShare,
      setSelfMonitoringActive,
      getNativeMicrophonePreviewTrack,
    }),
    [
      cameraEnabled,
      channelId,
      connectionPhase,
      deafened,
      focusedMediaId,
      stageFocusNonce,
      join,
      leave,
      watchParticipantScreenShare,
      localVoiceReady,
      micEnabled,
      micIssue,
      mediaAvailability,
      micPublishing,
      participantCount,
      screenShareEnabledForUi,
      screenShareStartingForUi,
      speakingUserIds,
      stageMediaFilters,
      stageMediaItemsForUi,
      stageFullscreen,
      status,
      rtcDebugEnabled,
      rtcDebugHistory,
      rtcDebugSnapshot,
      voicePingMs,
      voicePingHistory,
      toggleCamera,
      toggleDeafen,
      toggleMic,
      toggleScreenShare,
      toggleStageFullscreen,
      setSelfMonitoringActive,
      setStageMediaFilters,
      setStageMediaSubscribed,
      getNativeMicrophonePreviewTrack,
    ],
  )

  return (
    <VoiceContext.Provider value={value}>
      {children}
      <NativeScreenShareCoordinator />
      <DesktopScreenSharePicker />
    </VoiceContext.Provider>
  )
}
