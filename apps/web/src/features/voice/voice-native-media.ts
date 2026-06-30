import type { MutableRef } from '#/features/voice/voice-types'

type NativeMicrophoneSessionLike = {
  sessionId?: string
  channelId?: string | null
  disconnect: () => void
  reconnect?: (
    livekit: LiveKitNativePublisherCredentials,
    requestId: string,
    muted: boolean,
    audioBitrateKbps: number,
  ) => Promise<unknown> | unknown
  setMuted?: (muted: boolean) => Promise<unknown> | unknown
}

type NativeScreenShareSessionLike = {
  stop: () => Promise<unknown> | unknown
}

type DesktopMediaLike = {
  cancelPendingStarts: () => Promise<unknown> | unknown
  disconnectPreparedScreenSession: () => Promise<unknown> | unknown
  prepareScreenSession?: (options: {
    livekit: LiveKitNativePublisherCredentials
  }) => Promise<unknown> | unknown
}

type DesktopLike = {
  platform: { os: string }
  media: DesktopMediaLike
}

export type ResetNativeMediaStateDeps = {
  nativeMicrophoneStartGenerationRef: MutableRef<number>
  nativeMicrophoneStartRef: MutableRef<Promise<boolean> | null>
  screenShareStartGenerationRef: MutableRef<number>
  screenShareStartingRef: MutableRef<boolean>
  pendingScreenShareStartRef: MutableRef<unknown>
  nativeMicrophoneRef: MutableRef<NativeMicrophoneSessionLike | null>
  nativeMicrophoneMutedRef: MutableRef<boolean>
  selfMonitoringRef: MutableRef<{
    active: boolean
    restorePublishing: boolean
    sequence: number
  }>
  nativeScreenShareRef: MutableRef<NativeScreenShareSessionLike | null>
  stoppedNativeScreenIdentityRef: MutableRef<string | null>
  nativeScreenPublicationLossKeyRef: MutableRef<string | null>
  watchedRemoteScreenIdsRef?: MutableRef<Set<string>>
  pendingScreenWatchIdsRef?: MutableRef<Set<string>>
  resetNativeMediaEngineStats: () => void
  getDesktop: () => DesktopLike | null | undefined
  clearWatchedScreenIds: boolean
  resetStatsWithoutActiveScreen: boolean
}

export type SetNativeMicrophoneMutedDeps = {
  nativeMicrophoneRef: MutableRef<NativeMicrophoneSessionLike | null>
  nativeMicrophoneMutedRef: MutableRef<boolean>
  setMicPublishing: (publishing: boolean) => void
  setSelfSpeaking: (speaking: boolean) => void
  syncRoomParticipants: () => void
}

export type LiveKitNativeMediaKind = 'microphone' | 'screen' | 'camera'

export type LiveKitNativePublisherCredentials = {
  url: string
  token: string
  participantIdentity: string
}

export type LiveKitNativeCredentials = Record<
  LiveKitNativeMediaKind,
  LiveKitNativePublisherCredentials
>

export type RefreshNativeLiveKitCredentialsDeps<TRawCredentials> = {
  liveKitCredentialsRef: MutableRef<LiveKitNativeCredentials | null>
  channelIdRef: MutableRef<string | null>
  readCurrentVoiceFlags: () => { selfMute: boolean; selfDeaf: boolean }
  shouldRefreshLiveKitToken: (
    credentials: LiveKitNativePublisherCredentials,
  ) => boolean
  runVoiceRequest: <T>(
    key: string,
    request: () => Promise<T>,
    timeoutMs: number,
  ) => Promise<T | null | undefined>
  requestCredentialsRefresh: (
    channelId: string,
    selfMute: boolean,
    selfDeaf: boolean,
    operationId: string,
  ) => Promise<TRawCredentials>
  createOperationId: () => string
  nativeCredentialsFromJoinResponse: (
    credentials: TRawCredentials,
  ) => LiveKitNativeCredentials
  getDesktop: () => DesktopLike | null | undefined
}

export type DisconnectNativeMediaForHandoffDeps = Omit<
  ResetNativeMediaStateDeps,
  | 'clearWatchedScreenIds'
  | 'resetStatsWithoutActiveScreen'
  | 'watchedRemoteScreenIdsRef'
  | 'pendingScreenWatchIdsRef'
> & {
  setMicPublishing: (publishing: boolean) => void
  setSelfSpeaking: (speaking: boolean) => void
  setScreenShareEnabled: (enabled: boolean) => void
  setScreenShareStarting: (starting: boolean) => void
  setCameraEnabled: (enabled: boolean) => void
  dispatchNativeMedia: (action: { type: 'reset' }) => void
}

export type StartNativeMicrophoneDeps<
  TRoom extends { localParticipant: unknown },
  TSession extends NativeMicrophoneSessionLike,
> = {
  room: TRoom
  muted: boolean
  getTargetChannelId: () => string | null
  isCurrentVoiceSession: (
    room: TRoom,
    targetChannelId: string | null,
  ) => boolean
  nativeMicrophoneRef: MutableRef<TSession | null>
  nativeMicrophoneStartRef: MutableRef<Promise<boolean> | null>
  nativeMicrophoneStartGenerationRef: MutableRef<number>
  nativeMicrophoneMutedRef: MutableRef<boolean>
  setNativeMicrophoneMuted: (muted: boolean) => Promise<void>
  publishNativeMicrophone: (
    localParticipant: TRoom['localParticipant'],
    onStopped: (sessionId: string) => void,
    credentials: LiveKitNativePublisherCredentials,
    requestId: string,
    muted: boolean,
    audioBitrateKbps: number,
  ) => Promise<TSession>
  refreshNativeLiveKitCredentials: (
    mediaKind: 'microphone',
  ) => Promise<LiveKitNativePublisherCredentials>
  activeChannelAudioBitrateKbps: () => number
  createRequestId: () => string
  onNativeMicrophoneStopped: (sessionId: string) => void
  setNativeMicrophoneSession: (session: TSession) => void
  setMicPublishing: (publishing: boolean) => void
  setSelfSpeaking: (speaking: boolean) => void
  syncRoomParticipants: () => void
}

export function resetNativeMediaState(deps: ResetNativeMediaStateDeps) {
  deps.nativeMicrophoneStartGenerationRef.current += 1
  deps.nativeMicrophoneStartRef.current = null
  deps.screenShareStartGenerationRef.current += 1
  deps.screenShareStartingRef.current = false
  deps.pendingScreenShareStartRef.current = null

  const activeNativeMicrophone = deps.nativeMicrophoneRef.current
  if (activeNativeMicrophone) {
    deps.nativeMicrophoneRef.current = null
    activeNativeMicrophone.disconnect()
  }
  deps.nativeMicrophoneMutedRef.current = false
  deps.selfMonitoringRef.current.restorePublishing = false
  deps.selfMonitoringRef.current.sequence += 1

  if (deps.nativeScreenShareRef.current) {
    void Promise.resolve(deps.nativeScreenShareRef.current.stop()).catch(() => {})
    deps.nativeScreenShareRef.current = null
    deps.resetNativeMediaEngineStats()
  } else if (deps.resetStatsWithoutActiveScreen) {
    deps.resetNativeMediaEngineStats()
  }

  deps.stoppedNativeScreenIdentityRef.current = null
  deps.nativeScreenPublicationLossKeyRef.current = null
  if (deps.clearWatchedScreenIds) {
    deps.watchedRemoteScreenIdsRef?.current.clear()
    deps.pendingScreenWatchIdsRef?.current.clear()
  }

  const desktop = deps.getDesktop()
  if (desktop?.platform.os === 'win32') {
    void Promise.resolve(desktop.media.cancelPendingStarts()).catch(() => {})
    void Promise.resolve(desktop.media.disconnectPreparedScreenSession()).catch(
      () => {},
    )
  }
}

export async function setNativeMicrophoneMuted(
  deps: SetNativeMicrophoneMutedDeps,
  muted: boolean,
) {
  const previousMuted = deps.nativeMicrophoneMutedRef.current
  deps.nativeMicrophoneMutedRef.current = muted
  const active = deps.nativeMicrophoneRef.current
  deps.setMicPublishing(Boolean(active) && !muted)
  if (muted) deps.setSelfSpeaking(false)
  if (!active) return
  try {
    await active.setMuted?.(muted)
    deps.syncRoomParticipants()
  } catch (error) {
    deps.nativeMicrophoneMutedRef.current = previousMuted
    deps.setMicPublishing(
      Boolean(deps.nativeMicrophoneRef.current) && !previousMuted,
    )
    throw error
  }
}

export async function refreshNativeLiveKitCredentials<TRawCredentials>(
  deps: RefreshNativeLiveKitCredentialsDeps<TRawCredentials>,
  mediaKind: LiveKitNativeMediaKind,
  force = false,
): Promise<LiveKitNativePublisherCredentials> {
  const current = deps.liveKitCredentialsRef.current
  if (
    !force &&
    current &&
    !deps.shouldRefreshLiveKitToken(current[mediaKind])
  ) {
    return current[mediaKind]
  }

  const activeChannelId = deps.channelIdRef.current
  if (!activeChannelId) {
    throw new Error('LiveKit credentials are not available')
  }

  const { selfMute, selfDeaf } = deps.readCurrentVoiceFlags()
  const credentials = await deps.runVoiceRequest(
    `voice_refresh:${activeChannelId}:native`,
    () =>
      deps.requestCredentialsRefresh(
        activeChannelId,
        selfMute,
        selfDeaf,
        deps.createOperationId(),
      ),
    10_000,
  )
  if (!credentials) {
    throw new Error('Не удалось обновить LiveKit token')
  }

  const next = deps.nativeCredentialsFromJoinResponse(credentials)
  deps.liveKitCredentialsRef.current = next
  const desktop = deps.getDesktop()
  if (desktop?.platform.os === 'win32') {
    void Promise.resolve(
      desktop.media.prepareScreenSession?.({ livekit: next.screen }),
    ).catch(() => {})
  }
  return next[mediaKind]
}

export function disconnectNativeMediaForHandoff(
  deps: DisconnectNativeMediaForHandoffDeps,
) {
  resetNativeMediaState({
    nativeMicrophoneStartGenerationRef: deps.nativeMicrophoneStartGenerationRef,
    nativeMicrophoneStartRef: deps.nativeMicrophoneStartRef,
    screenShareStartGenerationRef: deps.screenShareStartGenerationRef,
    screenShareStartingRef: deps.screenShareStartingRef,
    pendingScreenShareStartRef: deps.pendingScreenShareStartRef,
    nativeMicrophoneRef: deps.nativeMicrophoneRef,
    nativeMicrophoneMutedRef: deps.nativeMicrophoneMutedRef,
    selfMonitoringRef: deps.selfMonitoringRef,
    nativeScreenShareRef: deps.nativeScreenShareRef,
    stoppedNativeScreenIdentityRef: deps.stoppedNativeScreenIdentityRef,
    nativeScreenPublicationLossKeyRef: deps.nativeScreenPublicationLossKeyRef,
    resetNativeMediaEngineStats: deps.resetNativeMediaEngineStats,
    getDesktop: deps.getDesktop,
    clearWatchedScreenIds: false,
    resetStatsWithoutActiveScreen: true,
  })
  deps.setMicPublishing(false)
  deps.setSelfSpeaking(false)
  deps.setScreenShareEnabled(false)
  deps.setScreenShareStarting(false)
  deps.setCameraEnabled(false)
  deps.dispatchNativeMedia({ type: 'reset' })
}

export async function startNativeMicrophone<
  TRoom extends { localParticipant: unknown },
  TSession extends NativeMicrophoneSessionLike,
>(deps: StartNativeMicrophoneDeps<TRoom, TSession>) {
  const targetChannelId = deps.getTargetChannelId()
  if (!deps.isCurrentVoiceSession(deps.room, targetChannelId)) {
    return false
  }

  const active = deps.nativeMicrophoneRef.current
  if (active) {
    if (
      targetChannelId &&
      active.channelId &&
      active.channelId !== targetChannelId &&
      active.reconnect
    ) {
      await active.reconnect(
        await deps.refreshNativeLiveKitCredentials('microphone'),
        deps.createRequestId(),
        deps.muted,
        deps.activeChannelAudioBitrateKbps(),
      )
      // Recency-check после await: за время reconnect'а пользователя могло
      // перекинуть в другой канал (move/leave). Не мутируем состояние и не
      // пушим side-effects в возможный stale-канал.
      if (
        !deps.isCurrentVoiceSession(deps.room, targetChannelId)
      ) {
        return false
      }
      active.channelId = targetChannelId
      deps.nativeMicrophoneMutedRef.current = deps.muted
      deps.setMicPublishing(!deps.muted)
      if (deps.muted) deps.setSelfSpeaking(false)
      deps.syncRoomParticipants()
      return true
    }
    await deps.setNativeMicrophoneMuted(deps.muted)
    return deps.isCurrentVoiceSession(deps.room, targetChannelId)
  }

  const pendingNativeMicrophoneStart = deps.nativeMicrophoneStartRef.current
  if (pendingNativeMicrophoneStart) {
    const started = await pendingNativeMicrophoneStart
    if (!started || !deps.isCurrentVoiceSession(deps.room, targetChannelId)) {
      return false
    }
    if (deps.nativeMicrophoneRef.current) {
      await deps.setNativeMicrophoneMuted(deps.muted)
    } else {
      deps.nativeMicrophoneMutedRef.current = deps.muted
    }
    return deps.isCurrentVoiceSession(deps.room, targetChannelId)
  }

  deps.nativeMicrophoneMutedRef.current = deps.muted
  const startGeneration = deps.nativeMicrophoneStartGenerationRef.current
  const requestId = deps.createRequestId()
  const start = (async (): Promise<boolean> => {
    let session: TSession
    try {
      if (!deps.isCurrentVoiceSession(deps.room, targetChannelId)) {
        return false
      }
      session = await deps.publishNativeMicrophone(
        deps.room.localParticipant,
        deps.onNativeMicrophoneStopped,
        await deps.refreshNativeLiveKitCredentials('microphone'),
        requestId,
        deps.muted,
        deps.activeChannelAudioBitrateKbps(),
      )
    } catch (error) {
      if (!deps.isCurrentVoiceSession(deps.room, targetChannelId)) {
        return false
      }
      throw error
    }

    if (
      deps.nativeMicrophoneStartGenerationRef.current !== startGeneration ||
      !deps.isCurrentVoiceSession(deps.room, targetChannelId)
    ) {
      session.disconnect()
      return false
    }

    session.channelId = targetChannelId
    deps.setNativeMicrophoneSession(session)
    deps.setMicPublishing(!deps.muted)
    if (deps.muted) deps.setSelfSpeaking(false)
    deps.syncRoomParticipants()
    return true
  })()

  deps.nativeMicrophoneStartRef.current = start
  try {
    return await start
  } finally {
    if (deps.nativeMicrophoneStartRef.current === start) {
      deps.nativeMicrophoneStartRef.current = null
    }
  }
}
