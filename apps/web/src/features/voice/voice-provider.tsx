import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type VideoTrack,
} from 'livekit-client'
import { toast } from 'sonner'

import { ScreenShareQualityDialog } from '#/components/voice/screen-share-quality-dialog'
import { useAuth } from '#/features/auth/auth-context'
import { joinChannelCall } from '#/features/api/voice-api'
import { resolveVoiceNodeName } from '#/features/voice/voice-node'
import { ApiError } from '#/lib/api/client'
import type { UserVoiceState } from '#/features/sync/voice-types'
import {
  canUseVoiceRestApi,
  handleVoiceApiError,
} from '#/features/voice/voice-api-capability'
import { syncStore } from '#/features/sync/sync-store'
import {
  isRateLimitedError,
  runVoiceRequest,
} from '#/features/voice/voice-request-gate'
import { applyAllRemoteAudio, applyRemoteAudioElement } from '#/features/voice/remote-audio-settings'
import { voiceListenerStore } from '#/features/voice/voice-listener-store'
import {
  liveKitChannelParticipants,
  patchLocalVoiceDeafen,
  patchLocalVoiceMic,
  removeLocalUserFromAllVoiceChannels,
  syncLiveKitRoomParticipants,
} from '#/features/voice/voice-participant-sync'
import {
  appendVoicePingSample,
  type VoicePingSample,
} from '#/features/voice/voice-ping-history'
import { measureVoicePingMs } from '#/features/voice/voice-ping'
import {
  createVoiceRoomOptions,
  screenShareCaptureOptions,
} from '#/features/voice/voice-capture'
import { applyMicProcessing, refreshMicProcessing } from '#/features/voice/voice-mic-processing'
import type { ScreenShareQualityName } from '#/features/voice/voice-preference-types'
import {
  readVoicePreferences,
  voicePreferenceStore,
} from '#/features/voice/voice-preference-store'
import {
  isStageVideoSource,
  pickStageVideoTrack,
  stageVideoTrackKey,
} from '#/features/voice/voice-stage-tracks'

type VoiceStatus = 'idle' | 'connecting' | 'connected'

type VoiceContextValue = {
  channelId: string | null
  status: VoiceStatus
  micEnabled: boolean
  deafened: boolean
  participantCount: number
  /** Участники активной комнаты LiveKit (дополняют WebSocket в UI). */
  liveChannelParticipants: UserVoiceState[]
  speakingUserIds: ReadonlySet<string>
  /** RTT до LiveKit в мс; null пока нет замера. */
  voicePingMs: number | null
  /** История замеров для графика в поповере подключения. */
  voicePingHistory: readonly VoicePingSample[]
  cameraEnabled: boolean
  screenShareEnabled: boolean
  getStageVideoTrack: (userId: string) => VideoTrack | null
  focusUserId: string | null
  setFocusUserId: (userId: string | null) => void
  stageFullscreen: boolean
  toggleStageFullscreen: () => void
  join: (channelId: string) => Promise<void>
  leave: () => void
  toggleMic: () => void
  toggleDeafen: () => void
  toggleCamera: () => void
  toggleScreenShare: () => void
}

const VoiceContext = createContext<VoiceContextValue | null>(null)

export function VoiceProvider({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const roomRef = useRef<Room | null>(null)
  const audioElementsRef = useRef<HTMLAudioElement[]>([])
  const channelIdRef = useRef<string | null>(null)
  const deafenedRef = useRef(false)
  const joinBlockedUntilRef = useRef(0)
  const joinInFlightRef = useRef<{
    channelId: string
    promise: Promise<void>
  } | null>(null)
  const disconnectIntentRef = useRef<'none' | 'switch' | 'leave'>('none')
  const stageVideoTracksRef = useRef(new Map<string, VideoTrack>())

  const [channelId, setChannelId] = useState<string | null>(null)
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [micEnabled, setMicEnabled] = useState(
    () => readVoicePreferences().micEnabled,
  )
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
  const [stageVideoRevision, setStageVideoRevision] = useState(0)
  const [cameraEnabled, setCameraEnabled] = useState(false)
  const [screenShareEnabled, setScreenShareEnabled] = useState(false)
  const [focusUserId, setFocusUserId] = useState<string | null>(null)
  const [stageFullscreen, setStageFullscreen] = useState(false)
  const [screenShareDialogOpen, setScreenShareDialogOpen] = useState(false)

  channelIdRef.current = channelId
  deafenedRef.current = deafened

  const syncRoomParticipants = useCallback(() => {
    const room = roomRef.current
    const activeChannelId = channelIdRef.current
    if (!room || !activeChannelId) return
    const receiving = !deafenedRef.current
    const participants = liveKitChannelParticipants(room, receiving)
    setLiveChannelParticipants(participants)
    syncLiveKitRoomParticipants(activeChannelId, room, receiving)
    setCameraEnabled(room.localParticipant.isCameraEnabled)
    setScreenShareEnabled(room.localParticipant.isScreenShareEnabled)
  }, [])

  const cleanupAudio = useCallback(() => {
    for (const element of audioElementsRef.current) {
      element.remove()
    }
    audioElementsRef.current = []
  }, [])

  const restoreVoicePreferences = useCallback(() => {
    const prefs = readVoicePreferences()
    setMicEnabled(prefs.micEnabled)
    setDeafened(prefs.deafened)
    deafenedRef.current = prefs.deafened
  }, [])

  const resetVoiceState = useCallback(() => {
    setChannelId(null)
    setStatus('idle')
    restoreVoicePreferences()
    setParticipantCount(0)
    setLiveChannelParticipants([])
    setSpeakingUserIds(new Set())
    setVoicePingMs(null)
    setVoicePingHistory([])
    stageVideoTracksRef.current.clear()
    setStageVideoRevision((value) => value + 1)
    setCameraEnabled(false)
    setScreenShareEnabled(false)
    setFocusUserId(null)
    setStageFullscreen(false)
    setScreenShareDialogOpen(false)
  }, [restoreVoicePreferences])

  const abortJoinAttempt = useCallback(() => {
    cleanupAudio()
    resetVoiceState()
  }, [cleanupAudio, resetVoiceState])

  const leaveVoiceSession = useCallback(
    async (intent: 'switch' | 'leave' = 'switch') => {
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

  const syncStageVideoTracks = useCallback((room: Room) => {
    const next = new Map<string, VideoTrack>()
    const ingest = (
      userId: string,
      source: Track.Source,
      track: Track | null | undefined,
    ) => {
      if (!track || track.kind !== Track.Kind.Video || !isStageVideoSource(source)) {
        return
      }
      next.set(stageVideoTrackKey(userId, source), track as VideoTrack)
    }

    for (const publication of room.localParticipant.trackPublications.values()) {
      ingest(
        room.localParticipant.identity,
        publication.source,
        publication.track ?? null,
      )
    }

    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        ingest(participant.identity, publication.source, publication.track ?? null)
      }
    }

    stageVideoTracksRef.current = next
    setStageVideoRevision((value) => value + 1)
  }, [])

  const applyVoiceDevices = useCallback(async (room: Room) => {
    const prefs = readVoicePreferences()
    if (prefs.preferredAudioInputDevice) {
      await room
        .switchActiveDevice('audioinput', prefs.preferredAudioInputDevice)
        .catch(() => {})
    }
    if (prefs.preferredAudioOutputDevice) {
      await room
        .switchActiveDevice('audiooutput', prefs.preferredAudioOutputDevice)
        .catch(() => {})
    }
    applyAllRemoteAudio(deafenedRef.current)
  }, [])

  const attachAudio = useCallback(
    (room: Room) => {
      const playTrack = (track: Track, participant: RemoteParticipant) => {
        if (track.kind !== Track.Kind.Audio) return
        const element = track.attach() as HTMLAudioElement
        element.dataset.livekit = 'remote'
        element.dataset.livekitUserId = participant.identity
        document.body.appendChild(element)
        audioElementsRef.current.push(element)
        applyRemoteAudioElement(element, deafenedRef.current)
        void element.play().catch(() => {
          // autoplay policy
        })
      }

      const syncSpeakers = () => {
        setSpeakingUserIds(
          new Set(room.activeSpeakers.map((speaker) => speaker.identity)),
        )
      }

      const onParticipantsChanged = () => {
        setParticipantCount(room.numParticipants)
        syncRoomParticipants()
        syncStageVideoTracks(room)
      }

      room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
        if (participant.isLocal) return
        if (track.kind === Track.Kind.Audio) {
          playTrack(track, participant)
          return
        }
        onParticipantsChanged()
      })

      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach().forEach((element) => element.remove())
        onParticipantsChanged()
      })

      room.on(RoomEvent.ParticipantConnected, onParticipantsChanged)
      room.on(RoomEvent.ParticipantDisconnected, onParticipantsChanged)
      room.on(RoomEvent.LocalTrackPublished, onParticipantsChanged)
      room.on(RoomEvent.LocalTrackUnpublished, onParticipantsChanged)
      room.on(RoomEvent.ActiveSpeakersChanged, syncSpeakers)

      room.on(RoomEvent.Disconnected, () => {
        const intent = disconnectIntentRef.current
        if (intent === 'switch' || intent === 'leave') {
          disconnectIntentRef.current = 'none'
          return
        }
        abortJoinAttempt()
      })

      onParticipantsChanged()
      syncSpeakers()
    },
    [abortJoinAttempt, syncRoomParticipants, syncStageVideoTracks],
  )

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
        (status === 'connected' || status === 'connecting')
      ) {
        return
      }

      const inFlight = joinInFlightRef.current
      if (inFlight?.channelId === targetChannelId) {
        return inFlight.promise
      }
      if (inFlight) {
        await inFlight.promise.catch(() => {})
      }

      const targetChannel = syncStore.getState().channels[targetChannelId]
      if (!canUseVoiceRestApi(targetChannel)) {
        toast.error('Голос недоступен в этом канале')
        return
      }

      const runJoin = async () => {
        const switching =
          roomRef.current != null ||
          channelIdRef.current != null ||
          status !== 'idle'

        if (switching) {
          await leaveVoiceSession('switch')
        }

        setStatus('connecting')
        setChannelId(targetChannelId)
        restoreVoicePreferences()

        try {
          const credentials = await runVoiceRequest(
            `join_call:${targetChannelId}`,
            () => joinChannelCall(token, targetChannelId),
            10_000,
          )
          if (!credentials) {
            abortJoinAttempt()
            return
          }

          const { url, token: livekitToken } = credentials

          const room = new Room(createVoiceRoomOptions())
          roomRef.current = room
          attachAudio(room)

          await room.connect(url, livekitToken)

          const prefs = readVoicePreferences()
          await room.localParticipant.setMicrophoneEnabled(prefs.micEnabled)
          if (prefs.micEnabled) {
            await applyMicProcessing(room.localParticipant)
          }
          setMicEnabled(prefs.micEnabled)
          setDeafened(prefs.deafened)
          deafenedRef.current = prefs.deafened
          applyAllRemoteAudio(prefs.deafened)
          await applyVoiceDevices(room)

          setStatus('connected')
          syncRoomParticipants()

          const userId = auth.user?._id
          if (userId) {
            patchLocalVoiceMic(targetChannelId, userId, prefs.micEnabled)
            patchLocalVoiceDeafen(targetChannelId, userId, prefs.deafened)
          }
        } catch (error) {
          abortJoinAttempt()
          handleVoiceApiError(targetChannelId, error)
          joinBlockedUntilRef.current =
            Date.now() + (isRateLimitedError(error) ? 60_000 : 15_000)
          toast.error(
            error instanceof ApiError && error.status === 429
              ? 'Слишком много запросов. Подождите минуту и попробуйте снова.'
              : error instanceof ApiError && error.status === 400
                ? 'Голос недоступен в этом канале'
                : error instanceof Error
                  ? error.message
                  : 'Не удалось подключиться к голосу',
          )
        }
      }

      const promise = runJoin()
      joinInFlightRef.current = { channelId: targetChannelId, promise }
      try {
        await promise
      } finally {
        if (joinInFlightRef.current?.channelId === targetChannelId) {
          joinInFlightRef.current = null
        }
      }
    },
    [
      abortJoinAttempt,
      attachAudio,
      auth.session?.token,
      channelId,
      leaveVoiceSession,
      status,
      restoreVoicePreferences,
      syncRoomParticipants,
      applyVoiceDevices,
      auth.user?._id,
    ],
  )

  const getStageVideoTrack = useCallback(
    (userId: string) => {
      void stageVideoRevision
      return pickStageVideoTrack(stageVideoTracksRef.current, userId)
    },
    [stageVideoRevision],
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

  const startScreenShare = useCallback(
    async (quality: ScreenShareQualityName, withAudio: boolean) => {
      const room = roomRef.current
      if (!room) return

      voicePreferenceStore.setScreenShareQuality(quality)
      voicePreferenceStore.setScreenShareAudio(withAudio)

      try {
        const capture = screenShareCaptureOptions(quality)
        const publication = await room.localParticipant.setScreenShareEnabled(
          true,
          {
            resolution: capture.resolution,
            audio: withAudio,
          },
        )

        const videoTrack = publication?.videoTrack
        if (videoTrack?.mediaStreamTrack && capture.contentHint) {
          videoTrack.mediaStreamTrack.contentHint = capture.contentHint
        }

        videoTrack?.on('ended', () => {
          void room.localParticipant.setScreenShareEnabled(false).then(() => {
            setScreenShareEnabled(room.localParticipant.isScreenShareEnabled)
            syncRoomParticipants()
          })
        })

        setScreenShareEnabled(room.localParticipant.isScreenShareEnabled)
        syncRoomParticipants()
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : 'Не удалось начать демонстрацию экрана',
        )
      }
    },
    [syncRoomParticipants],
  )

  const toggleScreenShare = useCallback(() => {
    const room = roomRef.current
    if (!room) return

    if (room.localParticipant.isScreenShareEnabled) {
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
    if (prefs.screenShareQualityAsk) {
      setScreenShareDialogOpen(true)
      return
    }

    void startScreenShare(prefs.screenShareQuality, prefs.screenShareAudio)
  }, [startScreenShare])

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
      void room.localParticipant.setMicrophoneEnabled(nextMic).then(() => {
        if (nextMic) void applyMicProcessing(room.localParticipant)
        syncRoomParticipants()
      })
    }
    if (activeChannelId && userId) {
      patchLocalVoiceMic(activeChannelId, userId, nextMic)
    }
  }, [auth.user?._id, syncRoomParticipants])

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
      if (room) {
        void room.localParticipant.setMicrophoneEnabled(false)
      }
      if (activeChannelId && userId) {
        patchLocalVoiceMic(activeChannelId, userId, false)
      }
    }

    if (activeChannelId && userId) {
      patchLocalVoiceDeafen(activeChannelId, userId, nextDeafened)
    }
    if (room && activeChannelId) {
      syncRoomParticipants()
    }
  }, [auth.user?._id, syncRoomParticipants])

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
      if (status !== 'connected') return
      const room = roomRef.current
      if (!room) return
      void applyVoiceDevices(room)
      void refreshMicProcessing(room)
    })
  }, [applyVoiceDevices, status])

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

  const value = useMemo<VoiceContextValue>(
    () => ({
      channelId,
      status,
      micEnabled,
      deafened,
      participantCount,
      liveChannelParticipants,
      speakingUserIds,
      voicePingMs,
      voicePingHistory,
      cameraEnabled,
      screenShareEnabled,
      focusUserId,
      getStageVideoTrack,
      join,
      leave,
      setFocusUserId,
      stageFullscreen,
      toggleMic,
      toggleStageFullscreen,
      toggleDeafen,
      toggleCamera,
      toggleScreenShare,
    }),
    [
      cameraEnabled,
      channelId,
      deafened,
      focusUserId,
      getStageVideoTrack,
      join,
      leave,
      liveChannelParticipants,
      micEnabled,
      participantCount,
      screenShareEnabled,
      speakingUserIds,
      stageFullscreen,
      status,
      voicePingMs,
      voicePingHistory,
      toggleCamera,
      toggleDeafen,
      toggleMic,
      toggleScreenShare,
      toggleStageFullscreen,
    ],
  )

  const prefs = readVoicePreferences()

  return (
    <>
      <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>
      <ScreenShareQualityDialog
        open={screenShareDialogOpen}
        defaultQuality={prefs.screenShareQuality}
        defaultAudio={prefs.screenShareAudio}
        onConfirm={(quality, withAudio) => {
          setScreenShareDialogOpen(false)
          void startScreenShare(quality, withAudio)
        }}
        onCancel={() => setScreenShareDialogOpen(false)}
      />
    </>
  )
}

export function useVoice() {
  const context = useContext(VoiceContext)
  if (!context) {
    throw new Error('useVoice must be used within VoiceProvider')
  }
  return context
}
