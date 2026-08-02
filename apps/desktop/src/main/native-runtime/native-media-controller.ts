import type {
  DesktopDisplayMediaSource,
  NativeMediaDeviceInfo,
  NativeMediaRuntimeState,
  NativeMicrophoneMetricsEvent,
  NativeMicrophonePreviewStateEvent,
} from '@syrnike13/platform'

import type { DiagnosticLogSink } from './diagnostic-log'
import {
  isNativeRuntimeCommand,
  type MediaRuntimeCommand,
  type MediaRuntimeEvent,
} from './contract'
import type {
  NativeRuntimeSupervisor,
  NativeRuntimeSupervisorSnapshot,
} from './runtime-supervisor'
import { NativeRuntimeRequestError } from './runtime-supervisor'

const QUERY_TIMEOUT_MS = 5_000
const SESSION_TIMEOUT_MS = 20_000
const STOP_TIMEOUT_MS = 5_000
const REMOTE_VIDEO_FIRST_FRAME_TIMEOUT_MS = 8_000
const REMOTE_VIDEO_RETRY_BASE_DELAY_MS = 250
const REMOTE_VIDEO_RETRY_MAX_DELAY_MS = 8_000
const REMOTE_VIDEO_RECOVERY_WARNING_ATTEMPT = 10

type PreviewSessionState = {
  sessionId: string
  generation: number
  status: 'starting' | 'running'
}

type LocalScreenPreviewDemand = {
  demanded: boolean
  width: number
  height: number
  fps: number
}

export type RemoteScreenPublication = {
  sessionId: string
  generation: number
  trackId: string
  participantIdentity: string
  source: 'screen'
}

export type NativeMediaControllerEvent =
  | { type: 'runtimeState'; state: NativeMediaRuntimeState }
  | { type: 'microphoneMetrics'; event: NativeMicrophoneMetricsEvent }
  | { type: 'microphonePreviewState'; event: NativeMicrophonePreviewStateEvent }
  | {
      type: 'remoteVideoSessionReset'
      sessionId: string
      generation: number
    }

export type NativeMediaControllerOptions = {
  supervisor: NativeRuntimeSupervisor
  runtimeAvailable: () => boolean
  getSelfWindowHwnd: () => string | undefined
  processId?: number
  diagnostics?: DiagnosticLogSink
  remoteVideoFirstFrameTimeoutMs?: number
}

type RemoteVideoDemandState = {
  sessionId: string
  generation: number
  trackId: string
  demanded: boolean
  revision: number
  recoveryAttempt: number
  recoveryTimer: ReturnType<typeof setTimeout> | null
  recoveryPromise: Promise<boolean> | null
  recoveryWarningEmitted: boolean
  pendingSubscriptionRecovery: boolean
  lastFrameAt: number | null
  ignoreFailureUntil: number
}

export class NativeMediaController {
  private readonly listeners = new Set<(event: NativeMediaControllerEvent) => void>()
  private readonly unsubscribeRuntimeEvent: () => void
  private readonly unsubscribeRuntimeState: () => void
  private previewGeneration = 0
  private preview: PreviewSessionState | null = null
  private previewStartOperation: Promise<void> | null = null
  private lastRestoredRestartCount = 0
  private disposed = false
  private activeScreen: { sessionId: string; generation: number } | null = null
  private activeVoiceSession: { sessionId: string; generation: number } | null = null
  private readonly remoteScreenPublications = new Map<
    string,
    RemoteScreenPublication
  >()
  private readonly remoteVideoDemands = new Map<
    string,
    RemoteVideoDemandState
  >()
  private remoteVideoDemandRevision = 0
  private localScreenPreviewDemand: LocalScreenPreviewDemand = {
    demanded: false,
    width: 1280,
    height: 720,
    fps: 30,
  }

  constructor(private readonly options: NativeMediaControllerOptions) {
    this.unsubscribeRuntimeEvent = options.supervisor.onEvent((event) =>
      this.handleRuntimeEvent(event as MediaRuntimeEvent),
    )
    this.unsubscribeRuntimeState = options.supervisor.onStateChange((snapshot) =>
      this.handleSupervisorState(snapshot),
    )
  }

  subscribe(listener: (event: NativeMediaControllerEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start() {
    if (!this.options.runtimeAvailable()) return
    await this.options.supervisor.start()
  }

  getRuntimeState(): NativeMediaRuntimeState {
    const snapshot = this.options.supervisor.getSnapshot()
    return {
      available: this.options.runtimeAvailable(),
      status: snapshot.status,
      restartCount: snapshot.restartCount,
      degradedReason: snapshot.degradedReason,
      degradedRetryAttempt: snapshot.degradedRetryAttempt,
      nextRetryAt: snapshot.nextRetryAt,
    }
  }

  async retryRuntime() {
    if (!this.options.runtimeAvailable()) return this.getRuntimeState()
    await this.options.supervisor.retry()
    return this.getRuntimeState()
  }

  async supportsNativeScreenCapture() {
    if (!this.options.runtimeAvailable()) return false
    await this.start()
    const snapshot = this.options.supervisor.getSnapshot()
    return snapshot.status === 'ready' && Boolean(snapshot.ready?.capabilities.includes('screen'))
  }

  async listDevices(
    kind: 'audioinput' | 'audiooutput' | 'videoinput',
  ): Promise<NativeMediaDeviceInfo[]> {
    if (!this.options.runtimeAvailable()) return []
    const result = await this.request<unknown>({ type: 'listDevices', kind }, QUERY_TIMEOUT_MS)
    return Array.isArray(result) ? result.filter(isNativeMediaDeviceInfo) : []
  }

  async listDisplaySources(): Promise<DesktopDisplayMediaSource[]> {
    if (!this.options.runtimeAvailable()) return []
    const result = await this.request<unknown>(
      { type: 'listDisplaySources', selfWindowHwnd: this.options.getSelfWindowHwnd() },
      QUERY_TIMEOUT_MS,
    )
    return Array.isArray(result) ? result.filter(isDesktopDisplayMediaSource) : []
  }

  startMicrophonePreview(): Promise<void> {
    if (this.preview?.status === 'running') return Promise.resolve()
    if (this.previewStartOperation) return this.previewStartOperation
    const generation = ++this.previewGeneration
    const operation = this.startMicrophonePreviewNow(generation)
    this.previewStartOperation = operation
    void operation.finally(() => {
      if (this.previewStartOperation === operation) this.previewStartOperation = null
    }).catch(() => undefined)
    return operation
  }

  async stopMicrophonePreview() {
    const preview = this.preview
    const hadPreview = Boolean(preview || this.previewStartOperation)
    this.preview = null
    this.previewStartOperation = null
    ++this.previewGeneration
    if (preview) {
      await this.request(
        { type: 'stopPreview', sessionId: preview.sessionId, generation: preview.generation },
        STOP_TIMEOUT_MS,
      ).catch(() => undefined)
    }
    if (hadPreview) this.emit({ type: 'microphonePreviewState', event: { status: 'stopped' } })
  }

  async setRemoteVideoDemand(
    sessionId: string,
    generation: number,
    trackId: string,
    demanded: boolean,
  ) {
    if (!sessionId || !trackId) throw new Error('Remote video identity is required')
    if (!this.isCurrentVoiceSession(sessionId, generation)) return
    const key = remoteVideoDemandKey(sessionId, generation, trackId)
    const previous = this.remoteVideoDemands.get(key)
    if (previous?.recoveryTimer) clearTimeout(previous.recoveryTimer)
    const demand: RemoteVideoDemandState = {
      sessionId,
      generation,
      trackId,
      demanded,
      revision: ++this.remoteVideoDemandRevision,
      recoveryAttempt: 0,
      recoveryTimer: null,
      recoveryPromise: null,
      recoveryWarningEmitted: false,
      pendingSubscriptionRecovery: false,
      lastFrameAt: null,
      ignoreFailureUntil: demanded
        ? Date.now() + this.remoteVideoFirstFrameTimeout()
        : 0,
    }
    this.remoteVideoDemands.set(key, demand)
    this.armRemoteVideoRecovery(key, demand)
    try {
      await this.request(
        { type: 'setRemoteVideoDemand', sessionId, generation, trackId, demanded },
        2_000,
      )
      if (!demanded && this.remoteVideoDemands.get(key) === demand) {
        this.remoteVideoDemands.delete(key)
      }
    } catch (error) {
      this.retireRemoteVideoDemand(key, demand)
      if (!isSupersededRequest(error)) throw error
      this.logSupersededDemand(demand, 'setRemoteVideoDemand')
    }
  }

  isCurrentVoiceSession(sessionId: string, generation: number) {
    return this.activeVoiceSession?.sessionId === sessionId &&
      this.activeVoiceSession.generation === generation
  }

  isRemoteVideoDemanded(
    sessionId: string,
    generation: number,
    trackId: string,
  ) {
    return this.remoteVideoDemands.get(
      remoteVideoDemandKey(sessionId, generation, trackId),
    )?.demanded === true
  }

  listRemoteScreenPublications(): RemoteScreenPublication[] {
    return [...this.remoteScreenPublications.values()].map((publication) => ({
      ...publication,
    }))
  }

  resetRemoteVideoDemands() {
    const now = Date.now()
    for (const [key, demand] of this.remoteVideoDemands) {
      if (demand.recoveryTimer) clearTimeout(demand.recoveryTimer)
      demand.recoveryTimer = null
      demand.lastFrameAt = now
      demand.ignoreFailureUntil = now + this.remoteVideoFirstFrameTimeout()
      this.armRemoteVideoRecovery(key, demand)
    }
  }

  async recoverRemoteVideoDemand(
    sessionId: string,
    generation: number,
    trackId: string,
    mode: 'local' | 'subscription' = 'local',
  ) {
    const key = remoteVideoDemandKey(sessionId, generation, trackId)
    const desired = this.remoteVideoDemands.get(key)
    if (!desired?.demanded) return false
    if (desired.recoveryPromise) {
      if (mode === 'subscription') desired.pendingSubscriptionRecovery = true
      return desired.recoveryPromise
    }
    desired.recoveryAttempt += 1
    if (
      desired.recoveryAttempt >= REMOTE_VIDEO_RECOVERY_WARNING_ATTEMPT &&
      !desired.recoveryWarningEmitted
    ) {
      desired.recoveryWarningEmitted = true
      this.options.diagnostics?.({
        scope: 'native-media-controller',
        event: 'remote_video_recovery_degraded',
        kind: 'remote-video',
        stage: mode === 'subscription'
          ? 'native-subscription-retry'
          : 'native-bridge-restart',
        sessionId,
        generation,
        recoveryAttempt: desired.recoveryAttempt,
        reason: `no_frame_after_repeated_${mode}_recoveries`,
      })
    }
    this.options.diagnostics?.({
      scope: 'native-media-controller',
      event: 'remote_video_recovery_started',
      kind: 'remote-video',
      stage: mode === 'subscription'
        ? 'native-subscription-retry'
        : 'native-bridge-restart',
      sessionId,
      generation,
      recoveryAttempt: desired.recoveryAttempt,
      reason: mode === 'subscription'
        ? 'livekit_subscription_failed'
        : 'native_frame_timeout_or_local_pipeline_failure',
    })
    const recovery = this.performRemoteVideoRecovery(key, desired, mode)
    desired.recoveryPromise = recovery
    try {
      return await recovery
    } catch (error) {
      if (!isSupersededRequest(error)) throw error
      this.retireRemoteVideoDemand(key, desired)
      this.logSupersededDemand(desired, 'recoverRemoteVideoDemand')
      return false
    } finally {
      if (desired.recoveryPromise === recovery) {
        desired.recoveryPromise = null
      }
      if (desired.pendingSubscriptionRecovery &&
        this.remoteVideoDemands.get(key) === desired && desired.demanded) {
        desired.pendingSubscriptionRecovery = false
        this.armRemoteVideoRecovery(key, desired, true, 'subscription')
      }
    }
  }

  markRemoteVideoFrameReceived(
    sessionId: string,
    generation: number,
    trackId: string,
  ) {
    const key = remoteVideoDemandKey(sessionId, generation, trackId)
    const demand = this.remoteVideoDemands.get(key)
    if (!demand?.demanded) return
    const recovered = demand.lastFrameAt === null || demand.recoveryAttempt > 0
    demand.lastFrameAt = Date.now()
    demand.recoveryAttempt = 0
    demand.recoveryWarningEmitted = false
    demand.pendingSubscriptionRecovery = false
    demand.ignoreFailureUntil = 0
    if (recovered) {
      this.options.diagnostics?.({
        scope: 'native-media-controller',
        event: 'remote_video_frame_received',
        kind: 'remote-video',
        stage: 'native-decode',
        sessionId,
        generation,
      })
    }
    if (!demand.recoveryTimer) this.armRemoteVideoRecovery(key, demand)
  }

  private async performRemoteVideoRecovery(
    key: string,
    desired: RemoteVideoDemandState,
    mode: 'local' | 'subscription',
  ) {
    if (desired.recoveryTimer) {
      clearTimeout(desired.recoveryTimer)
      desired.recoveryTimer = null
    }
    if (mode === 'subscription') {
      // A confirmed LiveKit subscription failure is the only recovery allowed
      // to detach the remote track. Fence its unsubscribe callback so it cannot
      // start a parallel local retry.
      desired.ignoreFailureUntil =
        Date.now() + this.remoteVideoFirstFrameTimeout()
    }
    try {
      await this.request(
        {
          type: 'retryRemoteVideo',
          sessionId: desired.sessionId,
          generation: desired.generation,
          trackId: desired.trackId,
          mode,
          reason: mode === 'subscription'
            ? 'livekit_subscription_failed'
            : 'frame_timeout_or_local_pipeline_failure',
        },
        2_000,
      )
      const current = this.remoteVideoDemands.get(key)
      if (!current?.demanded || current.revision !== desired.revision) return false
      return true
    } finally {
      const current = this.remoteVideoDemands.get(key)
      if (current === desired && current.demanded) {
        this.armRemoteVideoRecovery(key, current, false, mode)
      }
    }
  }

  async setLocalScreenPreviewDemand(demand: LocalScreenPreviewDemand) {
    if (!demand || typeof demand.demanded !== 'boolean' ||
      !Number.isFinite(demand.width) || !Number.isFinite(demand.height) ||
      !Number.isFinite(demand.fps)) {
      throw new Error('Invalid local screen preview demand')
    }
    this.localScreenPreviewDemand = {
      demanded: Boolean(demand.demanded),
      width: Math.max(16, Math.min(3840, Math.trunc(demand.width))),
      height: Math.max(16, Math.min(2160, Math.trunc(demand.height))),
      fps: Math.max(1, Math.min(60, Math.trunc(demand.fps))),
    }
    const screen = this.activeScreen
    if (!screen) return
    await this.sendLocalScreenPreviewDemand(screen)
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    const hadPreview = Boolean(this.preview || this.previewStartOperation)
    this.preview = null
    this.previewStartOperation = null
    ++this.previewGeneration
    if (hadPreview) {
      this.emit({
        type: 'microphonePreviewState',
        event: { status: 'stopped' },
      })
    }
    this.retireVoiceSession()
    this.clearRemoteVideoDemands()
    this.remoteScreenPublications.clear()
    this.unsubscribeRuntimeEvent()
    this.unsubscribeRuntimeState()
    this.listeners.clear()
    await this.options.supervisor.shutdown().catch(() => undefined)
  }

  private async startMicrophonePreviewNow(generation: number) {
    await this.start()
    if (generation !== this.previewGeneration) throw new Error('Native microphone preview start cancelled')
    const preview: PreviewSessionState = {
      sessionId: crypto.randomUUID(),
      generation,
      status: 'starting',
    }
    this.preview = preview
    try {
      const result = await this.request<unknown>(
        { type: 'startPreview', sessionId: preview.sessionId, generation },
        SESSION_TIMEOUT_MS,
      )
      if (this.preview !== preview || generation !== this.previewGeneration) {
        await this.request(
          { type: 'stopPreview', sessionId: preview.sessionId, generation },
          STOP_TIMEOUT_MS,
        ).catch(() => undefined)
        throw new Error('Native microphone preview start cancelled')
      }
      readPreviewResult(result, preview.sessionId)
      preview.status = 'running'
      this.emit({ type: 'microphonePreviewState', event: { status: 'running' } })
    } catch (error) {
      if (this.preview === preview) this.preview = null
      throw error
    }
  }

  private request<T = unknown>(command: MediaRuntimeCommand, timeoutMs: number) {
    if (this.disposed) return Promise.reject(new Error('Native media controller is disposed'))
    if (!isNativeRuntimeCommand(command)) return Promise.reject(new Error('Invalid native runtime command'))
    return this.options.supervisor.request<T>(command, timeoutMs)
  }

  private handleRuntimeEvent(event: MediaRuntimeEvent) {
    if (
      event.type === 'voiceTerminal' &&
      this.isCurrentVoiceSession(event.sessionId, event.generation)
    ) {
      this.retireVoiceSession()
      return
    }
    if (event.type === 'sessionLifecycle' && event.kind === 'voice') {
      if (event.state.status === 'starting' || event.state.status === 'running') {
        this.activateVoiceSession(event.sessionId, event.generation)
      } else if (
        event.state.status === 'idle' &&
        this.activeVoiceSession?.sessionId === event.sessionId &&
        event.generation >= this.activeVoiceSession.generation
      ) {
        this.retireVoiceSession()
      }
      return
    }
    if (event.type === 'remoteVideoFrame') {
      if (!this.isCurrentVoiceSession(event.sessionId, event.generation)) return
      this.markRemoteVideoFrameReceived(
        event.sessionId,
        event.generation,
        event.trackId,
      )
      return
    }
    if (event.type === 'remoteScreenPublicationAvailable') {
      if (!this.isCurrentVoiceSession(event.sessionId, event.generation)) return
      this.remoteScreenPublications.set(event.trackId, {
        sessionId: event.sessionId,
        generation: event.generation,
        trackId: event.trackId,
        participantIdentity: event.participantIdentity,
        source: event.source,
      })
      return
    }
    if (event.type === 'remoteScreenPublicationUnavailable') {
      if (!this.isCurrentVoiceSession(event.sessionId, event.generation)) return
      this.remoteScreenPublications.delete(event.trackId)
      const key = remoteVideoDemandKey(
        event.sessionId,
        event.generation,
        event.trackId,
      )
      const demand = this.remoteVideoDemands.get(key)
      if (demand?.recoveryTimer) clearTimeout(demand.recoveryTimer)
      this.remoteVideoDemands.delete(key)
      return
    }
    if (event.type === 'remoteVideoTrackRemoved' ||
      event.type === 'remoteVideoFailed') {
      if (!this.isCurrentVoiceSession(event.sessionId, event.generation)) return
      const key = remoteVideoDemandKey(
        event.sessionId,
        event.generation,
        event.trackId,
      )
      const demand = this.remoteVideoDemands.get(key)
      const confirmedSubscriptionFailure = event.type === 'remoteVideoFailed' &&
        event.reason === 'subscription'
      if (demand?.demanded && (confirmedSubscriptionFailure ||
        Date.now() >= demand.ignoreFailureUntil)) {
        this.armRemoteVideoRecovery(
          key,
          demand,
          true,
          event.type === 'remoteVideoTrackRemoved' || confirmedSubscriptionFailure
            ? 'subscription'
            : 'local',
        )
      }
      return
    }
    if (event.type === 'microphoneMetrics') {
      this.emit({ type: 'microphoneMetrics', event: event.metrics })
      return
    }
    if (event.type === 'runtimeError') {
      const preview = this.preview
      if (
        !preview ||
        event.error.sessionId !== preview.sessionId ||
        event.error.generation !== preview.generation
      ) return
      this.preview = null
      this.previewStartOperation = null
      ++this.previewGeneration
      this.emit({
        type: 'microphonePreviewState',
        event: { status: 'error', message: event.error.message },
      })
      return
    }
    if (
      event.type === 'deviceList' ||
      event.type === 'displaySourceList' ||
      event.type === 'localScreenPreviewFrame' ||
      event.type === 'localScreenPreviewTrackRemoved' ||
      event.type === 'localScreenPreviewFailed' ||
      event.type === 'localCameraPreviewFrame' ||
      event.type === 'localCameraPreviewTrackRemoved' ||
      event.type === 'localCameraPreviewFailed'
    ) return
    if (event.type === 'sessionLifecycle' && event.kind === 'screen') {
      if (event.state.status === 'starting' || event.state.status === 'running') {
        const next = { sessionId: event.sessionId, generation: event.generation }
        if (this.activeScreen && event.generation < this.activeScreen.generation) {
          return
        }
        const changed = this.activeScreen?.sessionId !== next.sessionId ||
          this.activeScreen.generation !== next.generation
        this.activeScreen = next
        if (changed) void this.sendLocalScreenPreviewDemand(next).catch(() => undefined)
      } else if (this.activeScreen?.sessionId === event.sessionId &&
        event.generation >= this.activeScreen.generation) {
        this.activeScreen = null
      }
    }
    if (event.type === 'sessionStopped' && this.activeScreen?.sessionId === event.sessionId &&
      event.generation >= this.activeScreen.generation) {
      this.activeScreen = null
    }
    const preview = this.preview
    if (!preview || event.sessionId !== preview.sessionId || event.generation !== preview.generation) return
    if (event.type === 'sessionStopped') {
      this.preview = null
      this.previewStartOperation = null
      ++this.previewGeneration
      this.emit({ type: 'microphonePreviewState', event: { status: 'stopped' } })
    }
  }

  private handleSupervisorState(snapshot: NativeRuntimeSupervisorSnapshot) {
    this.emit({
      type: 'runtimeState',
      state: {
        available: this.options.runtimeAvailable(),
        status: snapshot.status,
        restartCount: snapshot.restartCount,
        degradedReason: snapshot.degradedReason,
        degradedRetryAttempt: snapshot.degradedRetryAttempt,
        nextRetryAt: snapshot.nextRetryAt,
      },
    })
    if (
      snapshot.status === 'degraded' ||
      snapshot.status === 'recovering' ||
      snapshot.status === 'stopped'
    ) {
      this.activeScreen = null
      this.retireVoiceSession()
    }
    if (snapshot.status === 'degraded' && (this.preview || this.previewStartOperation)) {
      this.preview = null
      this.previewStartOperation = null
      ++this.previewGeneration
      this.emit({
        type: 'microphonePreviewState',
        event: { status: 'error', message: snapshot.degradedReason ?? 'Native media runtime is unavailable' },
      })
    }
    if (snapshot.status !== 'ready' || snapshot.restartCount <= this.lastRestoredRestartCount) return
    this.lastRestoredRestartCount = snapshot.restartCount
    const previousPreview = this.preview
    if (!previousPreview || previousPreview.status !== 'running') return
    const preview: PreviewSessionState = {
      sessionId: crypto.randomUUID(),
      generation: ++this.previewGeneration,
      status: 'starting',
    }
    this.preview = preview
    void this.request(
      { type: 'startPreview', sessionId: preview.sessionId, generation: preview.generation },
      SESSION_TIMEOUT_MS,
    )
      .then((result) => {
        readPreviewResult(result, preview.sessionId)
        if (this.preview === preview) preview.status = 'running'
      })
      .catch((error) => {
        if (this.preview !== preview) return
        this.preview = null
        this.emit({
          type: 'microphonePreviewState',
          event: { status: 'error', message: error instanceof Error ? error.message : 'Native microphone preview recovery failed' },
        })
      })
  }

  private emit(event: NativeMediaControllerEvent) {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* Runtime behavior must not depend on observers. */ }
    }
  }

  private clearRemoteVideoDemands() {
    const demands = [...this.remoteVideoDemands.values()]
    this.remoteVideoDemands.clear()
    for (const demand of demands) {
      if (demand.recoveryTimer) clearTimeout(demand.recoveryTimer)
    }
  }

  private activateVoiceSession(sessionId: string, generation: number) {
    if (this.isCurrentVoiceSession(sessionId, generation)) return
    if (this.activeVoiceSession && generation <= this.activeVoiceSession.generation) {
      return
    }
    this.retireVoiceSession()
    this.activeVoiceSession = { sessionId, generation }
  }

  private retireVoiceSession() {
    const retired = this.activeVoiceSession
    if (!retired) return
    this.activeVoiceSession = null
    this.clearRemoteVideoDemands()
    this.remoteScreenPublications.clear()
    this.emit({
      type: 'remoteVideoSessionReset',
      sessionId: retired.sessionId,
      generation: retired.generation,
    })
  }

  private retireRemoteVideoDemand(
    key: string,
    demand: RemoteVideoDemandState,
  ) {
    if (this.remoteVideoDemands.get(key) !== demand) return
    if (demand.recoveryTimer) clearTimeout(demand.recoveryTimer)
    this.remoteVideoDemands.delete(key)
  }

  private logSupersededDemand(
    demand: RemoteVideoDemandState,
    stage: string,
  ) {
    this.options.diagnostics?.({
      scope: 'native-media-controller',
      event: 'remote_video_demand_superseded',
      kind: 'remote-video',
      stage,
      sessionId: demand.sessionId,
      generation: demand.generation,
    })
  }

  private armRemoteVideoRecovery(
    key: string,
    demand: RemoteVideoDemandState,
    failureKnown = false,
    mode: 'local' | 'subscription' = 'local',
  ) {
    if (demand.recoveryTimer) clearTimeout(demand.recoveryTimer)
    demand.recoveryTimer = null
    if (this.disposed || !demand.demanded) return
    const baseTimeout = this.remoteVideoFirstFrameTimeout()
    const backoff = Math.min(
      REMOTE_VIDEO_RETRY_MAX_DELAY_MS,
      REMOTE_VIDEO_RETRY_BASE_DELAY_MS *
        2 ** Math.min(demand.recoveryAttempt, 5),
    )
    const timeout = failureKnown
      ? backoff
      : baseTimeout + backoff
    demand.recoveryTimer = setTimeout(() => {
      demand.recoveryTimer = null
      if (this.remoteVideoDemands.get(key) !== demand || !demand.demanded) return
      if (!failureKnown && demand.lastFrameAt !== null &&
        Date.now() - demand.lastFrameAt < baseTimeout) {
        this.armRemoteVideoRecovery(key, demand)
        return
      }
      void this.recoverRemoteVideoDemand(
        demand.sessionId,
        demand.generation,
        demand.trackId,
        mode,
      ).catch(() => {
        if (this.remoteVideoDemands.get(key) === demand && demand.demanded) {
          this.armRemoteVideoRecovery(key, demand, true, mode)
        }
      })
    }, timeout)
    demand.recoveryTimer.unref?.()
  }

  private remoteVideoFirstFrameTimeout() {
    return Math.max(
      1_000,
      this.options.remoteVideoFirstFrameTimeoutMs ??
        REMOTE_VIDEO_FIRST_FRAME_TIMEOUT_MS,
    )
  }

  private sendLocalScreenPreviewDemand(screen: { sessionId: string; generation: number }) {
    const demand = this.localScreenPreviewDemand
    return this.request(
      {
        type: 'setLocalScreenPreviewDemand',
        ...screen,
        demanded: demand.demanded,
        electronMainPid: this.options.processId ?? process.pid,
        options: { width: demand.width, height: demand.height, fps: demand.fps },
      },
      2_000,
    )
  }
}

function remoteVideoDemandKey(
  sessionId: string,
  generation: number,
  trackId: string,
) {
  return `${sessionId}:${generation}:${trackId}`
}

function isSupersededRequest(error: unknown) {
  return error instanceof NativeRuntimeRequestError &&
    error.detail.code === 'stale_generation'
}

function unwrapResult(value: unknown) {
  return value && typeof value === 'object' && 'session' in value
    ? (value as { session: unknown }).session
    : value
}

function readPreviewResult(value: unknown, sessionId: string) {
  const result = unwrapResult(value)
  if (!result || typeof result !== 'object' || (result as { sessionId?: unknown }).sessionId !== sessionId) {
    throw new Error('Native runtime returned invalid preview metadata')
  }
}

function isNativeMediaDeviceInfo(value: unknown): value is NativeMediaDeviceInfo {
  if (!value || typeof value !== 'object') return false
  const device = value as Partial<NativeMediaDeviceInfo>
  return typeof device.deviceId === 'string' &&
    (device.kind === 'audioinput' || device.kind === 'audiooutput' || device.kind === 'videoinput') &&
    typeof device.label === 'string'
}

function isDesktopDisplayMediaSource(value: unknown): value is DesktopDisplayMediaSource {
  if (!value || typeof value !== 'object') return false
  const source = value as Partial<DesktopDisplayMediaSource>
  return typeof source.id === 'string' && typeof source.name === 'string' &&
    (source.type === 'screen' || source.type === 'window' || source.type === 'game')
}
