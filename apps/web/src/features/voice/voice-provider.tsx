import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
import {
  createVoiceJoinRunner,
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
  joinChannelCall,
  patchChannelVoiceState,
} from '#/features/api/voice-api'
import { resolveVoiceNodeName } from '#/features/voice/voice-node'
import { isValidVoiceUserId } from '#/features/sync/voice-participant-resolve'
import type { UserVoiceState } from '#/features/sync/voice-types'
import {
  canUseVoiceRestApi,
  handleVoiceApiError,
} from '#/features/voice/voice-api-capability'
import { syncStore } from '#/features/sync/sync-store'
import { applyAllRemoteAudio, applyRemoteAudioElement } from '#/features/voice/remote-audio-settings'
import { releaseRemoteAudioGain } from '#/features/voice/remote-audio-gain'
import { voiceListenerStore } from '#/features/voice/voice-listener-store'
import {
  liveKitChannelParticipants,
  patchLocalVoiceDeafen,
  patchLocalVoiceMic,
  removeLocalUserFromAllVoiceChannels,
  syncLiveKitRoomParticipants,
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
  voiceMicPublishOptions,
} from '#/features/voice/voice-capture'
import { tuneScreenShareAfterPublish } from '#/features/voice/voice-screen-share-tuning'
import { DesktopScreenSharePicker } from '#/features/voice/desktop-screen-share-picker'
import { nativeMediaEngineStatsStore } from '#/features/voice/native-media-engine-stats'
import { shouldUseNativeScreenShare } from '#/features/voice/native-screen-share-mode'
import {
  publishNativeScreenShare,
  type NativeScreenShareSession,
} from '#/features/voice/native-screen-share-publish'
import {
  configureNativeMicrophoneSession,
  publishNativeMicrophone,
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
import { clearSessionVoiceGateThreshold } from '#/features/voice/voice-gate-session'
import { voicePreferenceEffectFlags } from '#/features/voice/voice-preference-effects'
import {
  describeMicDeviceError,
  MIC_BLOCKED_WITHOUT_ERROR,
  shouldResetMicPreferenceOnIssue,
  type VoiceConnectionPhase,
  type VoiceMicIssue,
} from '#/features/voice/voice-mic-status'
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
  type StageMediaItem,
  type StageMediaTrackEntry,
  type StageMediaTrackSource,
  stageMediaItemId,
} from '#/features/voice/voice-stage-media'
import {
  applyStageScreenPublicationSubscription,
  setStageScreenSubscription,
  shouldSubscribeStageScreen,
} from '#/features/voice/voice-stage-subscription'
import { runVoiceRequest } from '#/features/voice/voice-request-gate'

type VoiceStatus = 'idle' | 'connecting' | 'connected'
type StageMediaPublication = {
  source: Track.Source
  track?: Track | null
  isMuted?: boolean
  isSubscribed?: boolean
  setSubscribed?: (subscribed: boolean) => void
  options?: {
    videoCodec?: string
    simulcast?: boolean
    degradationPreference?: string
    screenShareEncoding?: {
      maxBitrate?: number
      maxFramerate?: number
    }
  }
}

export type VoiceStageMediaItem = StageMediaItem<
  VideoTrack,
  StageMediaPublication
>

type VoiceContextValue = {
  channelId: string | null
  status: VoiceStatus
  connectionPhase: VoiceConnectionPhase
  /** LiveKit room connected and local media setup finished. */
  localVoiceReady: boolean
  /** Намерение пользователя: микрофон включён. */
  micEnabled: boolean
  /** Фактическая публикация микрофона в LiveKit. */
  micPublishing: boolean
  /** Причина, если микрофон хотели включить, но он недоступен. */
  micIssue: VoiceMicIssue | null
  deafened: boolean
  participantCount: number
  /** Участники активной комнаты LiveKit (дополняют WebSocket в UI). */
  liveChannelParticipants: UserVoiceState[]
  speakingUserIds: ReadonlySet<string>
  /** RTT до LiveKit в мс; null пока нет замера. */
  voicePingMs: number | null
  /** История замеров для графика в поповере подключения. */
  voicePingHistory: readonly VoicePingSample[]
  rtcDebugEnabled: boolean
  setRtcDebugEnabled: (enabled: boolean) => void
  rtcDebugSnapshot: RtcDebugSnapshot | null
  rtcDebugHistory: readonly RtcDebugSnapshot[]
  cameraEnabled: boolean
  screenShareEnabled: boolean
  screenShareStarting: boolean
  stageMediaItems: readonly VoiceStageMediaItem[]
  focusedMediaId: string | null
  setFocusedMediaId: (mediaId: string | null) => void
  stageMediaFilters: StageMediaFilters
  setStageMediaFilters: Dispatch<SetStateAction<StageMediaFilters>>
  setStageMediaSubscribed: (mediaId: string, subscribed: boolean) => void
  stageFullscreen: boolean
  toggleStageFullscreen: () => void
  join: (channelId: string) => Promise<void>
  leave: () => void
  toggleMic: () => void
  toggleDeafen: () => void
  toggleCamera: () => void
  toggleScreenShare: () => void
  setSelfMonitoringActive: (active: boolean) => void
  /** Трек активной native mic-сессии для превью в настройках без второго захвата. */
  getNativeMicrophonePreviewTrack: () => MediaStreamTrack | null
}

const VoiceContext = createContext<VoiceContextValue | null>(null)

const DEVICE_SWITCH_TIMEOUT_MS = 5_000
const STAGE_MEDIA_FILTERS_STORAGE_KEY = 'syrnike13.voice.stageMediaFilters'
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

function voiceStateEquals(left: UserVoiceState, right: UserVoiceState) {
  return (
    left.id === right.id &&
    left.joined_at === right.joined_at &&
    left.is_publishing === right.is_publishing &&
    left.is_receiving === right.is_receiving &&
    left.server_muted === right.server_muted &&
    left.server_deafened === right.server_deafened &&
    left.camera === right.camera &&
    left.screensharing === right.screensharing
  )
}

function voiceStateListEquals(
  left: readonly UserVoiceState[],
  right: readonly UserVoiceState[],
) {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (!voiceStateEquals(left[index], right[index])) return false
  }
  return true
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

export function VoiceProvider({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const roomRef = useRef<Room | null>(null)
  const nativeScreenShareRef = useRef<NativeScreenShareSession | null>(null)
  const stoppedNativeScreenIdentityRef = useRef<string | null>(null)
  const nativeMicrophoneRef = useRef<NativeMicrophoneSession | null>(null)
  const nativeMicrophoneMutedRef = useRef(false)
  const liveKitCredentialsRef = useRef<LiveKitNativeCredentials | null>(null)
  const watchedRemoteScreenIdsRef = useRef<Set<string>>(new Set())
  const audioElementsRef = useRef<HTMLAudioElement[]>([])
  const channelIdRef = useRef<string | null>(null)
  const deafenedRef = useRef(false)
  const micIssueRef = useRef<VoiceMicIssue | null>(null)
  const joinBlockedUntilRef = useRef(0)
  const joinInFlightRef = useRef<{
    channelId: string
    promise: Promise<boolean>
  } | null>(null)
  const disconnectIntentRef = useRef<'none' | 'switch' | 'leave'>('none')
  const selfMonitoringRef = useRef({
    active: false,
    restorePublishing: false,
    sequence: 0,
  })
  const voiceJoinDepsRef = useRef<VoiceJoinRunnerDeps>({
    getToken: () => undefined as string | undefined,
    getLocalUserId: () => undefined as string | undefined,
    isJoinBlocked: () => false,
    setJoinBlockedUntil: (_timestamp: number) => {},
    shouldLeaveBeforeJoin: () => false,
    leaveBeforeJoin: async () => {},
    beginConnecting: (
      _channelId: string,
      _preview: ReturnType<typeof createConnectingLocalVoiceState>[],
    ) => {},
    setActiveRoom: (_room: Room) => {},
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
      setJoinBlockedUntil: (timestamp) =>
        voiceJoinDepsRef.current.setJoinBlockedUntil(timestamp),
      shouldLeaveBeforeJoin: () =>
        voiceJoinDepsRef.current.shouldLeaveBeforeJoin(),
      leaveBeforeJoin: () => voiceJoinDepsRef.current.leaveBeforeJoin(),
      beginConnecting: (channelId, preview) =>
        voiceJoinDepsRef.current.beginConnecting(channelId, preview),
      setActiveRoom: (room) => voiceJoinDepsRef.current.setActiveRoom(room),
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
    Pick<VoiceRejoinControllerOptions, 'attemptRejoin' | 'onGiveUp' | 'isGatewayConnected'>
  >({
    attemptRejoin: async (_channelId: string) => false,
    onGiveUp: () => {},
    isGatewayConnected: () => false,
  })
  const voiceRejoinRef = useRef(
    createVoiceRejoinController({
      attemptRejoin: (channelId) =>
        voiceRejoinDepsRef.current.attemptRejoin(channelId),
      onGiveUp: () => voiceRejoinDepsRef.current.onGiveUp(),
      isGatewayConnected: () => voiceRejoinDepsRef.current.isGatewayConnected(),
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
  const [deafened, setDeafened] = useState(
    () => readVoicePreferences().deafened,
  )
  const [participantCount, setParticipantCount] = useState(0)
  const [liveChannelParticipants, setLiveChannelParticipants] = useState<
    UserVoiceState[]
  >([])
  const [speakingUserIds, setSpeakingUserIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const [voicePingMs, setVoicePingMs] = useState<number | null>(null)
  const [voicePingHistory, setVoicePingHistory] = useState<VoicePingSample[]>(
    [],
  )
  const [rtcDebugEnabled, setRtcDebugEnabled] = useState(false)
  const [rtcDebugSnapshot, setRtcDebugSnapshot] =
    useState<RtcDebugSnapshot | null>(null)
  const [rtcDebugHistory, setRtcDebugHistory] = useState<RtcDebugSnapshot[]>([])
  const [stageMediaItems, setStageMediaItemsState] = useState<
    VoiceStageMediaItem[]
  >([])
  const [stageMediaFilters, setStageMediaFiltersState] = useState(
    readStageMediaFilters,
  )
  const [cameraEnabled, setCameraEnabled] = useState(false)
  const [screenShareEnabled, setScreenShareEnabled] = useState(false)
  const [screenShareStarting, setScreenShareStarting] = useState(false)
  const [focusedMediaId, setFocusedMediaId] = useState<string | null>(null)
  const [stageFullscreen, setStageFullscreen] = useState(false)

  channelIdRef.current = channelId
  deafenedRef.current = deafened

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
      const mediaId = stageMediaItemId(
        baseVoiceIdentity(participant.identity),
        'screen',
      )
      const nextSubscribed =
        subscribed ??
        shouldSubscribeStageScreen({
          isLocal: false,
          mediaId,
          watchedRemoteScreenIds: watchedRemoteScreenIdsRef.current,
        })

      for (const publication of participant.trackPublications.values()) {
        applyStageScreenPublicationSubscription(publication, nextSubscribed)
      }

      return nextSubscribed
    },
    [],
  )

  const syncStageMediaItems = useCallback(
    (room: Room) => {
      const excludedNativeScreenIdentity = stoppedNativeScreenIdentityRef.current
      const excludedParticipantIdentities = excludedNativeScreenIdentity
        ? new Set([excludedNativeScreenIdentity])
        : undefined
      const participants = liveKitChannelParticipants(
        room,
        !deafenedRef.current,
        { excludedParticipantIdentities },
      )
      const tracks: StageMediaTrackEntry<
        VideoTrack,
        StageMediaPublication
      >[] = []
      const ingest = (
        userId: string,
        publication: StageMediaPublication | null | undefined,
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
                watchedRemoteScreenIds: watchedRemoteScreenIdsRef.current,
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

      const authUserId = auth.user?._id
      const liveKitIdentity = room.localParticipant.identity
      const items = buildStageMediaItems({
        participants,
        currentUserId: authUserId ?? liveKitIdentity,
        tracks,
        filters: stageMediaFilters,
      }).map((item) => ({
        ...item,
        isLocal: isVoiceLocalUserId(item.userId, authUserId, liveKitIdentity),
      }))

      const visibleRemoteScreenIds = new Set(
        items
          .filter((item) => item.kind === 'screen' && !item.isLocal)
          .map((item) => item.id),
      )
      for (const mediaId of Array.from(watchedRemoteScreenIdsRef.current)) {
        if (!visibleRemoteScreenIds.has(mediaId)) {
          watchedRemoteScreenIdsRef.current.delete(mediaId)
        }
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
    const activeChannelId = channelIdRef.current
    if (!room || !activeChannelId) return
    const receiving = !deafenedRef.current
    const excludedNativeScreenIdentity = stoppedNativeScreenIdentityRef.current
    const excludedParticipantIdentities = excludedNativeScreenIdentity
      ? new Set([excludedNativeScreenIdentity])
      : undefined
    const participants = liveKitChannelParticipants(room, receiving, {
      excludedParticipantIdentities,
    })
    const liveKitIdentity = room.localParticipant.identity
    if (
      participants.length === 0 &&
      !isValidVoiceUserId(liveKitIdentity)
    ) {
      return
    }
    setLiveChannelParticipants((current) =>
      voiceStateListEquals(current, participants) ? current : participants,
    )
    syncLiveKitRoomParticipants(activeChannelId, room, receiving, {
      excludedParticipantIdentities,
    })
    const localMedia = localParticipantVoiceFlags(room.localParticipant)
    setCameraEnabled(localMedia.camera)
    setScreenShareEnabled(
      localMedia.screensharing || Boolean(nativeScreenShareRef.current),
    )
    syncStageMediaItems(room)
  }, [syncStageMediaItems])

  const cleanupAudio = useCallback(() => {
    for (const element of audioElementsRef.current) {
      element.remove()
    }
    audioElementsRef.current = []
  }, [])

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

  const syncVoiceStateToServer = useCallback(
    async (
      channelId: string,
      data: { is_receiving?: boolean; is_publishing?: boolean },
    ) => {
      const token = auth.session?.token
      if (!token) return

      try {
        const updated = await patchChannelVoiceState(token, channelId, data)
        syncStore.patchVoiceParticipant(channelId, updated.id, updated)
      } catch (error) {
        handleVoiceApiError(channelId, error)
      }
    },
    [auth.session?.token],
  )

  const refreshNativeLiveKitCredentials = useCallback(
    async (
      mediaKind: LiveKitNativeMediaKind,
      force = false,
    ): Promise<LiveKitNativePublisherCredentials> => {
      const debugStartedAt = Date.now()
      const current = liveKitCredentialsRef.current
      if (
        !force &&
        current &&
        !shouldRefreshLiveKitToken(current[mediaKind])
      ) {
        if (mediaKind === 'screen') {
          // #region debug log
          fetch('http://127.0.0.1:64953/ingest/ac639b', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'ac639b', runId: 'screen-share-startup', hypothesisId: 'A-token', location: 'voice-provider.tsx:refreshNativeLiveKitCredentials', message: 'screen native credentials cache hit', data: { force, elapsedMs: Date.now() - debugStartedAt }, timestamp: Date.now() }) }).catch(() => {})
          // #endregion
        }
        return current[mediaKind]
      }

      const token = auth.session?.token
      const activeChannelId = channelIdRef.current
      if (!token || !activeChannelId) {
        throw new Error('LiveKit credentials are not available')
      }

      const credentials = await runVoiceRequest(
        `join_call:${activeChannelId}:native-refresh`,
        () =>
          joinChannelCall(token, activeChannelId, {
            force_disconnect: false,
          }),
        10_000,
      )
      if (mediaKind === 'screen') {
        // #region debug log
        fetch('http://127.0.0.1:64953/ingest/ac639b', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'ac639b', runId: 'screen-share-startup', hypothesisId: 'A-token', location: 'voice-provider.tsx:refreshNativeLiveKitCredentials', message: 'screen native credentials refreshed', data: { force, ok: Boolean(credentials), elapsedMs: Date.now() - debugStartedAt }, timestamp: Date.now() }) }).catch(() => {})
        // #endregion
      }
      if (!credentials) {
        throw new Error('Не удалось обновить LiveKit token')
      }

      const next: LiveKitNativeCredentials = {
        microphone: {
          url: credentials.url,
          token: credentials.native_microphone.token,
          participantIdentity: credentials.native_microphone.identity,
        },
        screen: {
          url: credentials.url,
          token: credentials.native_screen.token,
          participantIdentity: credentials.native_screen.identity,
        },
        camera: {
          url: credentials.url,
          token: credentials.native_camera.token,
          participantIdentity: credentials.native_camera.identity,
        },
      }
      liveKitCredentialsRef.current = next
      const desktop = getSyrnikeDesktop()
      if (desktop?.platform.os === 'win32') {
        void desktop.media.prepareScreenSession({ livekit: next.screen }).catch(() => {})
      }
      return next[mediaKind]
    },
    [auth.session?.token],
  )

  const resetVoiceState = useCallback(() => {
    if (nativeMicrophoneRef.current) {
      nativeMicrophoneRef.current.disconnect()
      nativeMicrophoneRef.current = null
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
    watchedRemoteScreenIdsRef.current.clear()
    const desktop = getSyrnikeDesktop()
    if (desktop?.platform.os === 'win32') {
      void desktop.media.disconnectPreparedScreenSession().catch(() => {})
    }
    setChannelId(null)
    setStatus('idle')
    setConnectionPhase('idle')
    setLocalVoiceReady(false)
    restoreVoicePreferences()
    setCurrentMicIssue(null)
    setParticipantCount(0)
    setLiveChannelParticipants([])
    setSpeakingUserIds(new Set())
    setVoicePingMs(null)
    setVoicePingHistory([])
    rtcDebugSnapshotRef.current = null
    setRtcDebugSnapshot(null)
    setRtcDebugHistory([])
    setStageMediaItems([])
    setCameraEnabled(false)
    setScreenShareEnabled(false)
    setScreenShareStarting(false)
    setFocusedMediaId(null)
    setStageFullscreen(false)
  }, [restoreVoicePreferences, setCurrentMicIssue, setStageMediaItems])

  const abortJoinAttempt = useCallback(() => {
    voiceRejoinRef.current.cancel()
    cleanupAudio()
    resetVoiceState()
  }, [cleanupAudio, resetVoiceState])

  const leaveVoiceSession = useCallback(
    async (intent: 'switch' | 'leave' = 'switch') => {
      voiceRejoinRef.current.cancel()
      const room = roomRef.current
      const leftChannelId = channelIdRef.current
      const userId = room?.localParticipant.identity ?? auth.user?._id

      if (room) {
        disconnectIntentRef.current = intent
        room.removeAllListeners()
        await room.disconnect()
        roomRef.current = null
      }

      cleanupAudio()
      clearSessionVoiceGateThreshold()
      resetVoiceState()

      if (leftChannelId && userId) {
        syncStore.removeVoiceParticipant(leftChannelId, userId)
      } else if (userId) {
        removeLocalUserFromAllVoiceChannels(userId)
      }

      disconnectIntentRef.current = 'none'
    },
    [auth.user?._id, cleanupAudio, resetVoiceState],
  )

  const leave = useCallback(() => {
    void leaveVoiceSession('leave')
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
    applyAllRemoteAudio(deafenedRef.current)
  }, [])

  const stopNativeMicrophone = useCallback(() => {
    const active = nativeMicrophoneRef.current
    if (!active) return
    nativeMicrophoneRef.current = null
    nativeMicrophoneMutedRef.current = false
    active.disconnect()
    setMicPublishing(false)
  }, [])

  const setNativeMicrophoneMuted = useCallback(
    async (muted: boolean) => {
      const previousMuted = nativeMicrophoneMutedRef.current
      nativeMicrophoneMutedRef.current = muted
      const active = nativeMicrophoneRef.current
      setMicPublishing(Boolean(active) && !muted)
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
    [syncRoomParticipants],
  )

  const startNativeMicrophone = useCallback(
    async (room: Room, muted = false) => {
      const active = nativeMicrophoneRef.current
      if (active) {
        await setNativeMicrophoneMuted(muted)
        return
      }
      nativeMicrophoneMutedRef.current = muted
      const session = await publishNativeMicrophone(
        room.localParticipant,
        (sessionId) => {
          if (nativeMicrophoneRef.current?.sessionId !== sessionId) return
          nativeMicrophoneRef.current = null
          nativeMicrophoneMutedRef.current = false
          setMicPublishing(false)
          syncRoomParticipants()
        },
        await refreshNativeLiveKitCredentials('microphone'),
        muted,
      )
      nativeMicrophoneRef.current = session
      setMicPublishing(!muted)
      syncRoomParticipants()
    },
    [
      refreshNativeLiveKitCredentials,
      setNativeMicrophoneMuted,
      syncRoomParticipants,
    ],
  )

  const finishLocalVoiceSetup = useCallback(
    async (room: Room, targetChannelId: string) => {
      const prefs = effectiveVoiceJoinPreferences(readVoicePreferences())
      const suppressedBySelfMonitoring =
        selfMonitoringRef.current.active && prefs.micEnabled
      let micSetupFailed = false
      try {
        if (shouldUseNativeMicrophone()) {
          await startNativeMicrophone(
            room,
            !prefs.micEnabled || suppressedBySelfMonitoring || prefs.deafened,
          )
        } else {
          await room.localParticipant.setMicrophoneEnabled(
            prefs.micEnabled && !suppressedBySelfMonitoring,
            undefined,
            voiceMicPublishOptions(),
          )
        }
      } catch (error) {
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
      applyAllRemoteAudio(prefs.deafened)
      await applyVoiceDevices(room)
      if (
        prefs.micEnabled &&
        !suppressedBySelfMonitoring &&
        !micSetupFailed &&
        !shouldUseNativeMicrophone()
      ) {
        await applyMicProcessing(room.localParticipant)
      }
      syncRoomParticipants()

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
        void syncVoiceStateToServer(targetChannelId, {
          is_receiving: !prefs.deafened,
          is_publishing: nextMicPublishing,
        })
      }
      setLocalVoiceReady(true)
      if (!micSetupFailed) {
        setConnectionPhase('connected')
      }
    },
    [
      applyVoiceDevices,
      auth.user?._id,
      setCurrentMicIssue,
      startNativeMicrophone,
      syncMicFromRoom,
      syncRoomParticipants,
      syncVoiceStateToServer,
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
        setCurrentMicIssue(null)
        if (userId) patchLocalVoiceMic(activeChannelId, userId, false)
        if (status === 'connected') {
          void syncVoiceStateToServer(activeChannelId, {
            is_publishing: false,
          })
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
        if (userId) patchLocalVoiceMic(activeChannelId, userId, false)
        if (status === 'connected') {
          void syncVoiceStateToServer(activeChannelId, {
            is_publishing: false,
          })
        }
        syncRoomParticipants()
        return
      }

      if (shouldUseNativeMicrophone()) {
        void startNativeMicrophone(room, false)
          .then(() => {
            if (
              selfMonitoringRef.current.active ||
              selfMonitoringRef.current.sequence !== sequence
            ) {
              void setNativeMicrophoneMuted(true).catch(() => {})
              return
            }
            setCurrentMicIssue(null)
            syncMicFromRoom(room)
            syncRoomParticipants()
            if (status === 'connected') {
              void syncVoiceStateToServer(activeChannelId, {
                is_publishing: true,
              })
            }
          })
          .catch((error) => {
            syncMicFromRoom(room, describeMicDeviceError(error))
            syncRoomParticipants()
          })
        return
      }

      void room.localParticipant
        .setMicrophoneEnabled(true, undefined, voiceMicPublishOptions())
        .then(() => {
          if (
            selfMonitoringRef.current.active ||
            selfMonitoringRef.current.sequence !== sequence
          ) {
            void room.localParticipant.setMicrophoneEnabled(false)
            return
          }
          void applyMicProcessing(room.localParticipant)
          setCurrentMicIssue(null)
          syncMicFromRoom(room)
          syncRoomParticipants()
          if (status === 'connected') {
            void syncVoiceStateToServer(activeChannelId, {
              is_publishing: participantMicPublishing(room.localParticipant),
            })
          }
        })
        .catch((error) => {
          syncMicFromRoom(room, describeMicDeviceError(error))
          syncRoomParticipants()
        })
    },
    [
      auth.user?._id,
      setCurrentMicIssue,
      startNativeMicrophone,
      status,
      setNativeMicrophoneMuted,
      syncMicFromRoom,
      syncRoomParticipants,
      syncVoiceStateToServer,
    ],
  )

  const attachAudio = useCallback(
    (room: Room) => {
      const removeRemoteAudioElement = (element: Element) => {
        if (element instanceof HTMLAudioElement) {
          releaseRemoteAudioGain(element)
          audioElementsRef.current = audioElementsRef.current.filter(
            (audioElement) => audioElement !== element,
          )
        }
        element.remove()
      }

      const playTrack = (
        track: Track,
        publication: RemoteTrackPublication,
        participant: RemoteParticipant,
      ) => {
        if (track.kind !== Track.Kind.Audio) return
        if (
          isDesktopNativeVoiceIdentity(participant.identity) &&
          baseVoiceIdentity(participant.identity) === auth.user?._id
        ) {
          track.detach().forEach(removeRemoteAudioElement)
          return
        }
        track.detach().forEach(removeRemoteAudioElement)
        const element = track.attach() as HTMLAudioElement
        const audioSource =
          publication.source === Track.Source.ScreenShareAudio ? 'stream' : 'mic'
        element.dataset.livekit = 'remote'
        element.dataset.livekitUserId = baseVoiceIdentity(participant.identity)
        element.dataset.livekitAudioSource = audioSource
        element.dataset.livekitAudioLevel = String(participant.audioLevel ?? 0)
        document.body.appendChild(element)
        audioElementsRef.current.push(element)
        applyRemoteAudioElement(element, deafenedRef.current)
        void element.play().catch(() => {
          // autoplay policy
        })
      }

      const syncSpeakers = () => {
        const nextSpeakers = new Set(
          room.activeSpeakers.map((speaker) => baseVoiceIdentity(speaker.identity)),
        )
        setSpeakingUserIds((current) =>
          stringSetEquals(current, nextSpeakers) ? current : nextSpeakers,
        )
        const levels = new Map<string, number>()
        for (const participant of room.remoteParticipants.values()) {
          const userId = baseVoiceIdentity(participant.identity)
          levels.set(
            userId,
            Math.max(levels.get(userId) ?? 0, participant.audioLevel ?? 0),
          )
        }
        for (const element of audioElementsRef.current) {
          const userId = element.dataset.livekitUserId
          if (!userId) continue
          if (element.dataset.livekitAudioSource !== 'stream') {
            element.dataset.livekitAudioLevel = String(levels.get(userId) ?? 0)
          }
          applyRemoteAudioElement(element, deafenedRef.current)
        }
      }

      const onParticipantsChanged = () => {
        setParticipantCount(room.numParticipants)
        syncRoomParticipants()
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
            track.detach().forEach(removeRemoteAudioElement)
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

      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach().forEach(removeRemoteAudioElement)
        onParticipantsChanged()
      })

      room.on(RoomEvent.ParticipantConnected, onParticipantsChanged)
      room.on(RoomEvent.ParticipantDisconnected, onParticipantsChanged)
      room.on(RoomEvent.LocalTrackPublished, onParticipantsChanged)
      room.on(RoomEvent.LocalTrackUnpublished, onParticipantsChanged)
      room.on(RoomEvent.TrackPublished, (publication, participant) => {
        if (!participant.isLocal) {
          applyRemoteScreenParticipantSubscription(participant)
        }
        onParticipantsChanged()
      })
      room.on(RoomEvent.TrackUnpublished, onParticipantsChanged)
      room.on(RoomEvent.TrackMuted, onParticipantsChanged)
      room.on(RoomEvent.TrackUnmuted, onParticipantsChanged)
      room.on(RoomEvent.ActiveSpeakersChanged, syncSpeakers)

      room.on(RoomEvent.Connected, () => {
        if (!channelIdRef.current) return
        setStatus('connected')
        onParticipantsChanged()
      })

      room.on(RoomEvent.MediaDevicesError, (error, kind) => {
        if (kind !== 'audioinput') return
        syncMicFromRoom(room, describeMicDeviceError(error))
      })

      room.on(RoomEvent.Disconnected, () => {
        const intent = disconnectIntentRef.current
        if (intent === 'switch' || intent === 'leave') {
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
        cleanupAudio()
        setStatus('connecting')
        setConnectionPhase('reconnecting')
        setLocalVoiceReady(false)
        voiceRejoinRef.current.onUnexpectedDisconnect(targetChannelId)
      })

      onParticipantsChanged()
      syncSpeakers()
    },
    [
      abortJoinAttempt,
      auth.user?._id,
      cleanupAudio,
      applyRemoteScreenParticipantSubscription,
      syncMicFromRoom,
      syncRoomParticipants,
    ],
  )

  useEffect(() => {
    voiceJoinDepsRef.current = {
      getToken: () => auth.session?.token,
      getLocalUserId: () => auth.user?._id,
      isJoinBlocked: () => Date.now() < joinBlockedUntilRef.current,
      setJoinBlockedUntil: (timestamp) => {
        joinBlockedUntilRef.current = timestamp
      },
      shouldLeaveBeforeJoin: () =>
        roomRef.current != null ||
        channelIdRef.current != null ||
        status !== 'idle',
      leaveBeforeJoin: () => leaveVoiceSession('switch'),
      beginConnecting: (targetChannelId, preview) => {
        setStatus('connecting')
        setLocalVoiceReady(false)
        setChannelId(targetChannelId)
        restoreVoicePreferences()
        setLiveChannelParticipants((current) =>
          voiceStateListEquals(current, preview) ? current : preview,
        )
      },
      setActiveRoom: (room) => {
        roomRef.current = room
      },
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
        setStatus('connected')
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
    finishLocalVoiceSetup,
    leaveVoiceSession,
    restoreVoicePreferences,
    status,
    syncRoomParticipants,
  ])

  useEffect(() => {
    voiceRejoinDepsRef.current = {
      attemptRejoin: (channelId) =>
        performVoiceJoinRef.current(channelId, { rejoin: true }),
      onGiveUp: abortJoinAttempt,
      isGatewayConnected: () => auth.gatewayState === 'connected',
    }
  }, [abortJoinAttempt, auth.gatewayState])

  useEffect(() => {
    const unsubscribe = eventsGateway.subscribeState((state) => {
      if (state !== 'connected') return
      voiceRejoinRef.current.onGatewayConnected()
    })
    return () => {
      void unsubscribe()
    }
  }, [])

  const join = useCallback(
    async (targetChannelId: string) => {
      const token = auth.session?.token
      if (!token) {
        toast.error('Нет сессии')
        return
      }

      if (Date.now() < joinBlockedUntilRef.current) {
        return
      }

      if (
        channelId === targetChannelId &&
        status === 'connected' &&
        roomRef.current != null
      ) {
        return
      }

      const inFlight = joinInFlightRef.current
      if (inFlight?.channelId === targetChannelId) {
        await inFlight.promise
        return
      }
      if (inFlight) {
        await inFlight.promise.catch(() => {})
      }

      const targetChannel = syncStore.getState().channels[targetChannelId]
      if (!canUseVoiceRestApi(targetChannel)) {
        toast.error('Голос недоступен в этом канале')
        return
      }

      const promise = performVoiceJoinRef.current(targetChannelId)
      joinInFlightRef.current = { channelId: targetChannelId, promise }
      try {
        await promise
      } finally {
        if (joinInFlightRef.current?.channelId === targetChannelId) {
          joinInFlightRef.current = null
        }
      }
    },
    [auth.session?.token, channelId, status],
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
    nativeScreenShareRef.current = null
    stoppedNativeScreenIdentityRef.current =
      active.nativeParticipantIdentity ?? null
    nativeMediaEngineStatsStore.reset()
    await active.stop()
  }, [])

  const setStageMediaSubscribed = useCallback(
    (mediaId: string, subscribed: boolean) => {
      const room = roomRef.current
      if (!room) return
      const item = stageMediaItemsRef.current.find(
        (stageItem) => stageItem.id === mediaId,
      )
      const action = setStageScreenSubscription(item, subscribed)

      if (item?.kind === 'screen' && !item.isLocal) {
        if (subscribed) {
          watchedRemoteScreenIdsRef.current.add(mediaId)
        } else {
          watchedRemoteScreenIdsRef.current.delete(mediaId)
        }

        for (const participant of room.remoteParticipants.values()) {
          if (baseVoiceIdentity(participant.identity) !== item.userId) continue
          applyRemoteScreenParticipantSubscription(participant, subscribed)
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
      stopNativeScreenShare,
      syncRoomParticipants,
      syncStageMediaItems,
    ],
  )

  const toggleCamera = useCallback(() => {
    const room = roomRef.current
    if (!room) return
    const next = !room.localParticipant.isCameraEnabled
    void room.localParticipant
      .setCameraEnabled(next)
      .then(() => {
        setCameraEnabled(next)
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
    ) => {
      const capture = screenShareCaptureOptions(quality)
      const publication = await room.localParticipant.setScreenShareEnabled(
        true,
        {
          ...capture.capture,
          audio: screenShareAudioCaptureOptions(withAudio),
        },
        withAudio
          ? screenShareCombinedPublishOptions(quality)
          : capture.publish,
      )
      if (publication) {
        ;(publication as StageMediaPublication).options = {
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
        )
      }

      videoTrack?.on('ended', () => {
        void room.localParticipant.setScreenShareEnabled(false).then(() => {
          setScreenShareEnabled(
            localParticipantVoiceFlags(room.localParticipant).screensharing,
          )
          syncRoomParticipants()
        })
      })
    },
    [syncRoomParticipants],
  )

  const startLocalScreenShare = useCallback(
    async (quality: ScreenShareQualityName, withAudio: boolean) => {
      const room = roomRef.current
      if (!room) return

      voicePreferenceStore.setScreenShareQuality(quality)
      voicePreferenceStore.setScreenShareAudio(withAudio)
      setScreenShareStarting(true)

      const prefs = readVoicePreferences()
      const desktop = getSyrnikeDesktop()
      const useNative = shouldUseNativeScreenShare(prefs.screenShareCaptureMode)
      const debugStartedAt = Date.now()

      try {
        if (useNative && desktop) {
          stoppedNativeScreenIdentityRef.current = null
          const pickerPromise = waitForNativePickerSelection()
          // #region debug log
          fetch('http://127.0.0.1:64953/ingest/ac639b', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'ac639b', runId: 'screen-share-startup', hypothesisId: 'A-picker', location: 'voice-provider.tsx:startLocalScreenShare', message: 'native display picker opening', data: { quality, withAudio, elapsedMs: Date.now() - debugStartedAt }, timestamp: Date.now() }) }).catch(() => {})
          // #endregion
          await desktop.media.openDisplayPicker(withAudio)
          const selection = await pickerPromise
          // #region debug log
          fetch('http://127.0.0.1:64953/ingest/ac639b', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'ac639b', runId: 'screen-share-startup', hypothesisId: 'A-picker', location: 'voice-provider.tsx:startLocalScreenShare', message: 'native display picker selected', data: { quality, audioRequested: selection.audioRequested, sourceKind: selection.sourceId.split(':')[0], elapsedMs: Date.now() - debugStartedAt }, timestamp: Date.now() }) }).catch(() => {})
          // #endregion
          voicePreferenceStore.setScreenShareAudio(selection.audioRequested)
          const handleSidecarLost = (message: string) => {
            console.warn('[voice] native media engine lost', message)
            toast.error('Нативный захват прерван')
            void stopNativeScreenShare().catch(() => {})
            setScreenShareEnabled(false)
            syncRoomParticipants()
          }
          const startNative = async (forceRefresh: boolean) =>
            publishNativeScreenShare(
              room,
              room.localParticipant,
              selection.sourceId,
              quality,
              selection.audioRequested,
              handleSidecarLost,
              await refreshNativeLiveKitCredentials('screen', forceRefresh),
            )

          let session: NativeScreenShareSession
          try {
            session = await startNative(false)
          } catch (error) {
            if (!isLiveKitTokenFailure(error)) throw error
            await stopNativeScreenShare()
            session = await startNative(true)
          }
          nativeScreenShareRef.current = session
          setScreenShareEnabled(true)
          setScreenShareStarting(false)
          syncRoomParticipants()
          return
        }

        if (desktop?.platform.os === 'win32') {
          throw new Error('Нативный media engine недоступен')
        }

        await startBrowserScreenShare(room, quality, withAudio)
        setScreenShareEnabled(
          localParticipantVoiceFlags(room.localParticipant).screensharing,
        )
        setScreenShareStarting(false)
        syncRoomParticipants()
      } catch (error) {
        setScreenShareStarting(false)
        if (desktop?.platform.os === 'win32') {
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
      startBrowserScreenShare,
      stopNativeScreenShare,
      syncRoomParticipants,
    ],
  )

  const toggleScreenShare = useCallback(() => {
    const room = roomRef.current
    if (!room) return
    if (screenShareStarting) return

    if (room.localParticipant.isScreenShareEnabled || nativeScreenShareRef.current) {
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
    setMicEnabled(nextMic)
    if (!nextMic) {
      setCurrentMicIssue(null)
    }

    const wasDeafened = deafenedRef.current
    if (nextMic && wasDeafened) {
      voicePreferenceStore.setDeafened(false)
      setDeafened(false)
      deafenedRef.current = false
      applyAllRemoteAudio(false)
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
              syncMicFromRoom(room, describeMicDeviceError(error))
              syncRoomParticipants()
            })
            setMicPublishing(false)
            setCurrentMicIssue(null)
            if (activeChannelId && userId) {
              patchLocalVoiceMic(activeChannelId, userId, false)
              if (status === 'connected') {
                void syncVoiceStateToServer(activeChannelId, {
                  is_publishing: false,
                })
              }
            }
            syncRoomParticipants()
            return
          }
          void startNativeMicrophone(room, false)
            .then(() => {
              syncMicFromRoom(room)
              syncRoomParticipants()
            })
            .catch((error) => {
              syncMicFromRoom(room, describeMicDeviceError(error))
              syncRoomParticipants()
            })
        } else {
          selfMonitoringRef.current.restorePublishing = false
          void startNativeMicrophone(room, true).catch((error) => {
            syncMicFromRoom(room, describeMicDeviceError(error))
            syncRoomParticipants()
          })
          syncMicFromRoom(room)
          syncRoomParticipants()
        }
        return
      }
      if (!nextMic) {
        selfMonitoringRef.current.restorePublishing = false
      }
      void room.localParticipant
        .setMicrophoneEnabled(
          nextMic && !selfMonitoringRef.current.active,
          undefined,
          voiceMicPublishOptions(),
        )
        .then(() => {
          if (nextMic && selfMonitoringRef.current.active) {
            selfMonitoringRef.current.restorePublishing = true
            setMicPublishing(false)
            setCurrentMicIssue(null)
            if (activeChannelId && userId) {
              patchLocalVoiceMic(activeChannelId, userId, false)
            }
          } else {
            if (nextMic) void applyMicProcessing(room.localParticipant)
            syncMicFromRoom(room)
          }
          syncRoomParticipants()
          if (nextMic && selfMonitoringRef.current.active && activeChannelId) {
            void syncVoiceStateToServer(activeChannelId, {
              is_publishing: false,
            })
          }
        })
        .catch((error) => {
          syncMicFromRoom(room, describeMicDeviceError(error))
          syncRoomParticipants()
        })
      return
    }

    setMicPublishing(nextMic)
    if (activeChannelId && userId) {
      patchLocalVoiceMic(activeChannelId, userId, nextMic)
    }
  }, [
    auth.user?._id,
    setCurrentMicIssue,
    startNativeMicrophone,
    status,
    syncMicFromRoom,
    syncRoomParticipants,
    syncVoiceStateToServer,
  ])

  const toggleDeafen = useCallback(() => {
    const room = roomRef.current
    const activeChannelId = channelIdRef.current
    const userId = auth.user?._id
    const nextDeafened = !voicePreferenceStore.getDeafened()
    voicePreferenceStore.setDeafened(nextDeafened)
    setDeafened(nextDeafened)
    deafenedRef.current = nextDeafened
    applyAllRemoteAudio(nextDeafened)

    if (nextDeafened) {
      voicePreferenceStore.setMicEnabled(false)
      setMicEnabled(false)
      setMicPublishing(false)
      setCurrentMicIssue(null)
      if (room) {
        if (shouldUseNativeMicrophone()) {
          void startNativeMicrophone(room, true).catch((error) => {
            syncMicFromRoom(room, describeMicDeviceError(error))
            syncRoomParticipants()
          })
        } else {
          void room.localParticipant.setMicrophoneEnabled(false)
        }
      }
      if (activeChannelId && userId) {
        patchLocalVoiceMic(activeChannelId, userId, false)
      }
    }

    if (activeChannelId && userId) {
      patchLocalVoiceDeafen(activeChannelId, userId, nextDeafened)
      if (status === 'connected') {
        void syncVoiceStateToServer(activeChannelId, {
          is_receiving: !nextDeafened,
          ...(nextDeafened ? { is_publishing: false } : {}),
        })
      }
    }
    if (room && activeChannelId) {
      syncRoomParticipants()
    }
  }, [
    auth.user?._id,
    setCurrentMicIssue,
    startNativeMicrophone,
    status,
    syncRoomParticipants,
    syncVoiceStateToServer,
  ])

  useEffect(() => {
    if (status === 'connected') {
      applyAllRemoteAudio(deafened)
    }
  }, [deafened, status])

  useEffect(() => {
    return voiceListenerStore.subscribe(() => {
      if (status === 'connected') {
        applyAllRemoteAudio(deafenedRef.current)
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
            void refreshMicProcessing(room)
          }
        })
      } else if (effects.remoteAudioChanged) {
        applyAllRemoteAudio(deafenedRef.current)
      }
      if (effects.micProcessingChanged) {
        if (shouldUseNativeMicrophone()) {
          configureNativeMicrophoneSession(nativeMicrophoneRef.current, next)
        } else {
          void refreshMicProcessing(room)
        }
      }
    })
  }, [applyVoiceDevices, startNativeMicrophone, status])

  useEffect(() => {
    return () => {
      leave()
    }
  }, [leave])

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

  const value = useMemo<VoiceContextValue>(
    () => ({
      channelId,
      status,
      connectionPhase,
      localVoiceReady,
      micEnabled,
      micPublishing,
      micIssue,
      deafened,
      participantCount,
      liveChannelParticipants,
      speakingUserIds,
      voicePingMs,
      voicePingHistory,
      rtcDebugEnabled,
      setRtcDebugEnabled,
      rtcDebugSnapshot,
      rtcDebugHistory,
      cameraEnabled,
      screenShareEnabled,
      screenShareStarting,
      stageMediaItems: stageMediaItemsForUi,
      focusedMediaId,
      join,
      leave,
      setFocusedMediaId,
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
      join,
      leave,
      liveChannelParticipants,
      localVoiceReady,
      micEnabled,
      micIssue,
      micPublishing,
      participantCount,
      screenShareEnabled,
      screenShareStarting,
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

export function useVoice() {
  const context = useContext(VoiceContext)
  if (!context) {
    throw new Error('useVoice must be used within VoiceProvider')
  }
  return context
}
