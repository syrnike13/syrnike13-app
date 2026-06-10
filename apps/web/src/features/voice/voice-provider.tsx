import {
  useCallback,
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
import { resolveVoiceNodeName } from '#/features/voice/voice-node'
import {
  createVoiceJoinRunner,
  nativeCredentialsFromJoinResponse,
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
import { isValidVoiceUserId } from '#/features/sync/voice-participant-resolve'
import {
  canJoinVoiceChannel,
} from '#/features/voice/voice-api-capability'
import { syncStore } from '#/features/sync/sync-store'
import {
  createRemoteAudioMixer,
  type RemoteAudioMixer,
  type RemoteAudioSource,
} from '#/features/voice/remote-audio-mixer'
import { voiceListenerStore } from '#/features/voice/voice-listener-store'
import {
  liveKitRoomParticipantIds,
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
  type VoiceStatus,
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
import { channelAudioBitrateKbps } from '#/lib/channel-audio-bitrate'
import {
  VoiceContext,
  type VoiceContextValue,
  type VoiceStageMediaItem,
  type VoiceStageMediaPublication,
} from '#/features/voice/voice-context'

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

type AudioTrackWithMedia = Track & {
  mediaStreamTrack?: MediaStreamTrack
  sid?: string
}

function audioSourceFromPublication(
  publication: RemoteTrackPublication,
): RemoteAudioSource {
  return publication.source === Track.Source.ScreenShareAudio ? 'stream' : 'mic'
}

function remoteAudioTrackId(
  track: Track,
  publication: RemoteTrackPublication,
) {
  const audioTrack = track as AudioTrackWithMedia
  return (
    publication.trackSid ??
    publication.sid ??
    audioTrack.sid ??
    audioTrack.mediaStreamTrack?.id ??
    crypto.randomUUID()
  )
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
  const remoteAudioMixerRef = useRef<RemoteAudioMixer | null>(null)
  const channelIdRef = useRef<string | null>(null)
  const deafenedRef = useRef(false)
  const micPublishingRef = useRef(readVoicePreferences().micEnabled)
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
  const [speakingUserIds, setSpeakingUserIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  )
  const setSpeakingUserIdsIfChanged = useCallback(
    (next: ReadonlySet<string>) => {
      setSpeakingUserIds((current) =>
        stringSetEquals(current, next) ? current : new Set(next),
      )
    },
    [],
  )
  if (!remoteAudioMixerRef.current) {
    remoteAudioMixerRef.current = createRemoteAudioMixer({
      onSpeakingUserIdsChange: setSpeakingUserIdsIfChanged,
    })
  }
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
  micPublishingRef.current = micPublishing

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
    if (!room) return
    const localMedia = localParticipantVoiceFlags(room.localParticipant)
    setCameraEnabled(localMedia.camera)
    setScreenShareEnabled(
      localMedia.screensharing || Boolean(nativeScreenShareRef.current),
    )
    syncStageMediaItems(room)
  }, [syncStageMediaItems])

  const cleanupAudio = useCallback(() => {
    remoteAudioMixerRef.current?.clear()
    for (const element of document.querySelectorAll(
      'audio[data-syrnike-remote-audio-mixer="source"]',
    )) {
      element.remove()
    }
  }, [])

  const applyRemoteAudio = useCallback((deafened = deafenedRef.current) => {
    remoteAudioMixerRef.current?.applyVolumes(deafened)
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

  const syncVoiceFlagsToGateway = useCallback(
    (channelId: string, selfMute: boolean, selfDeaf: boolean) => {
      if (auth.gatewayState !== 'connected') return
      requestVoiceFlagsUpdate(channelId, selfMute, selfDeaf)
    },
    [auth.gatewayState],
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
    setSpeakingUserIdsIfChanged(new Set())
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
  }, [
    restoreVoicePreferences,
    setCurrentMicIssue,
    setSpeakingUserIdsIfChanged,
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

  const leaveVoiceSession = useCallback(
    async (intent: 'switch' | 'leave' = 'switch') => {
      voiceRejoinRef.current.cancel()
      const room = roomRef.current
      const leftChannelId = channelIdRef.current
      const userId = room?.localParticipant.identity ?? auth.user?._id
      // #region debug log
      fetch('http://127.0.0.1:65045/ingest/eef881',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'eef881',runId:'voice-switch-a-to-b',hypothesisId:'A,D',location:'apps/web/src/features/voice/voice-provider.tsx:leaveVoiceSession:start',message:'leave voice session start',data:{intent,leftChannelId,hasRoom:room!=null,gatewayState:auth.gatewayState},timestamp:Date.now()})}).catch(()=>{});
      // #endregion

      if (room) {
        disconnectIntentRef.current = intent
        room.removeAllListeners()
        await room.disconnect()
        roomRef.current = null
      }

      cleanupAudio()
      clearSessionVoiceGateThreshold()
      resetVoiceState()

      if (intent === 'leave' && auth.gatewayState === 'connected') {
        requestVoiceLeave()
      }

      if (leftChannelId && userId) {
        syncStore.removeVoiceParticipant(leftChannelId, userId)
      } else if (userId) {
        removeLocalUserFromAllVoiceChannels(userId)
      }

      disconnectIntentRef.current = 'none'
      // #region debug log
      fetch('http://127.0.0.1:65045/ingest/eef881',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'eef881',runId:'voice-switch-a-to-b',hypothesisId:'A,D',location:'apps/web/src/features/voice/voice-provider.tsx:leaveVoiceSession:end',message:'leave voice session end',data:{intent,leftChannelId,gatewayState:auth.gatewayState},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
    },
    [auth.gatewayState, auth.user?._id, cleanupAudio, resetVoiceState],
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
    remoteAudioMixerRef.current?.setOutputDevice(prefs.preferredAudioOutputDevice)
    applyRemoteAudio(deafenedRef.current)
  }, [applyRemoteAudio])

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
        activeChannelAudioBitrateKbps(),
      )
      nativeMicrophoneRef.current = session
      setMicPublishing(!muted)
      syncRoomParticipants()
    },
    [
      refreshNativeLiveKitCredentials,
      activeChannelAudioBitrateKbps,
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
            voiceMicPublishOptions(activeChannelAudioBitrateKbps()),
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
      remoteAudioMixerRef.current?.setOutputDevice(prefs.preferredAudioOutputDevice)
      applyRemoteAudio(prefs.deafened)
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
        syncVoiceFlagsToGateway(
          targetChannelId,
          !nextMicPublishing,
          prefs.deafened,
        )
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
      activeChannelAudioBitrateKbps,
      syncMicFromRoom,
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
        if (userId) patchLocalVoiceMic(activeChannelId, userId, false)
        if (status === 'connected') {
          syncVoiceFlagsToGateway(activeChannelId, true, deafenedRef.current)
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
              syncVoiceFlagsToGateway(
                activeChannelId,
                false,
                deafenedRef.current,
              )
            }
          })
          .catch((error) => {
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
            syncVoiceFlagsToGateway(
              activeChannelId,
              !participantMicPublishing(room.localParticipant),
              deafenedRef.current,
            )
          }
        })
        .catch((error) => {
          syncMicFromRoom(room, describeMicDeviceError(error))
          syncRoomParticipants()
        })
    },
    [
      auth.user?._id,
      activeChannelAudioBitrateKbps,
      setCurrentMicIssue,
      startNativeMicrophone,
      status,
      setNativeMicrophoneMuted,
      syncMicFromRoom,
      syncRoomParticipants,
      syncVoiceFlagsToGateway,
    ],
  )

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
            publicationSid: publication.sid,
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
            publicationSid: publication.sid,
            publicationTrackSid: publication.trackSid,
            mediaStreamTrackId: mediaStreamTrack.id,
          })
        }
        applyRemoteAudio(deafenedRef.current)
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
        for (const participant of preview) {
          syncStore.addVoiceParticipant(targetChannelId, participant)
        }
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

      const activeChannelId = channelIdRef.current
      if (status !== 'connected' || !activeChannelId) return
      const { selfMute, selfDeaf } = readCurrentVoiceFlags()
      requestVoiceFlagsUpdate(
        activeChannelId,
        selfMute,
        selfDeaf,
      )
    })
    return () => {
      void unsubscribe()
    }
  }, [readCurrentVoiceFlags, status])

  const join = useCallback(
    async (targetChannelId: string) => {
      const token = auth.session?.token
      const joinBlockedRemainingMs = Math.max(
        0,
        joinBlockedUntilRef.current - Date.now(),
      )
      // #region debug log
      fetch('http://127.0.0.1:65045/ingest/eef881',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'eef881',runId:'voice-switch-a-to-b',hypothesisId:'A,B,D',location:'apps/web/src/features/voice/voice-provider.tsx:join:start',message:'voice join requested',data:{targetChannelId,currentChannelId:channelId,status,hasRoom:roomRef.current!=null,joinBlockedRemainingMs,hasInFlight:joinInFlightRef.current!=null},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      if (!token) {
        toast.error('Нет сессии')
        return
      }

      if (Date.now() < joinBlockedUntilRef.current) {
        // #region debug log
        fetch('http://127.0.0.1:65045/ingest/eef881',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'eef881',runId:'voice-switch-a-to-b',hypothesisId:'B',location:'apps/web/src/features/voice/voice-provider.tsx:join:blocked',message:'voice join blocked by cooldown',data:{targetChannelId,currentChannelId:channelId,status,joinBlockedRemainingMs:Math.max(0,joinBlockedUntilRef.current-Date.now())},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
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
      if (!canJoinVoiceChannel(targetChannel)) {
        toast.error('Голос недоступен в этом канале')
        return
      }

      const promise = performVoiceJoinRef.current(targetChannelId)
      joinInFlightRef.current = { channelId: targetChannelId, promise }
      try {
        const joined = await promise
        // #region debug log
        fetch('http://127.0.0.1:65045/ingest/eef881',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'eef881',runId:'voice-switch-a-to-b',hypothesisId:'B,C,D',location:'apps/web/src/features/voice/voice-provider.tsx:join:done',message:'voice join finished',data:{targetChannelId,joined,currentChannelId:channelIdRef.current,status:joined?'connected':status,hasRoom:roomRef.current!=null,joinBlockedRemainingMs:Math.max(0,joinBlockedUntilRef.current-Date.now())},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
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
          ? screenShareCombinedPublishOptions(
              quality,
              activeChannelAudioBitrateKbps(),
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
    [activeChannelAudioBitrateKbps, syncRoomParticipants],
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

      try {
        if (useNative && desktop) {
          stoppedNativeScreenIdentityRef.current = null
          const pickerPromise = waitForNativePickerSelection()
          await desktop.media.openDisplayPicker(withAudio)
          const selection = await pickerPromise
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
              activeChannelAudioBitrateKbps(),
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
      activeChannelAudioBitrateKbps,
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
              syncMicFromRoom(room, describeMicDeviceError(error))
              syncRoomParticipants()
            })
            setMicPublishing(false)
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
            .then(() => {
              syncMicFromRoom(room)
              syncRoomParticipants()
              if (activeChannelId && userId && status === 'connected') {
                const { selfMute, selfDeaf } = readCurrentVoiceFlags(room)
                syncVoiceFlagsToGateway(activeChannelId, selfMute, selfDeaf)
              }
            })
            .catch((error) => {
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
            syncMicFromRoom(room, describeMicDeviceError(error))
            syncRoomParticipants()
          })
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
            setCurrentMicIssue(null)
            if (activeChannelId && userId) {
              patchLocalVoiceMic(activeChannelId, userId, false)
            }
          } else {
            if (nextMic) void applyMicProcessing(room.localParticipant)
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
    setCurrentMicIssue,
    readCurrentVoiceFlags,
    startNativeMicrophone,
    status,
    syncMicFromRoom,
    syncRoomParticipants,
    syncVoiceFlagsToGateway,
  ])

  const toggleDeafen = useCallback(() => {
    const room = roomRef.current
    const activeChannelId = channelIdRef.current
    const userId = auth.user?._id
    const nextDeafened = !voicePreferenceStore.getDeafened()
    voicePreferenceStore.setDeafened(nextDeafened)
    setDeafened(nextDeafened)
    deafenedRef.current = nextDeafened
    applyRemoteAudio(nextDeafened)

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
        syncVoiceFlagsToGateway(
          activeChannelId,
          nextDeafened || !voicePreferenceStore.getMicEnabled(),
          nextDeafened,
        )
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
    syncVoiceFlagsToGateway,
  ])

  useEffect(() => {
    if (status === 'connected') {
      applyRemoteAudio(deafened)
    }
  }, [deafened, status])

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
            void refreshMicProcessing(room)
          }
        })
      } else if (effects.remoteAudioChanged) {
        applyRemoteAudio(deafenedRef.current)
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
