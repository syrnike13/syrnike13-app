import {
  DesktopDisplayMediaSourceSchema,
  NativeMediaDeviceInfoSchema,
  type DesktopDisplayMediaSource,
  type DesktopDisplayMediaSourcePage,
  type NativeMediaDeviceInfo,
  type NativeMediaRuntimeState,
  type NativeMicrophoneMetricsEvent,
  type NativeMicrophonePreviewStateEvent,
} from '@syrnike13/platform'
import { Effect, Fiber, Layer, ManagedRuntime, Option, Schema } from 'effect'

import type { DiagnosticLogSink } from './diagnostic-log'
import {
  isNativeRuntimeCommand,
  nativeRuntimeError,
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
const REMOTE_VIDEO_DEGRADED_RECOVERY_ATTEMPT = 3
const DISPLAY_SOURCE_PAGE_SIZE = 24

const normalizeLocalScreenPreviewDemandEffect = Effect.fn(
  'nativeMedia.normalizeLocalScreenPreviewDemand',
)(function* (demand: LocalScreenPreviewDemand) {
  if (
    !demand ||
    typeof demand.demanded !== 'boolean' ||
    !Number.isFinite(demand.width) ||
    !Number.isFinite(demand.height) ||
    !Number.isFinite(demand.fps)
  ) {
    return yield* Effect.fail(
      new NativeRuntimeRequestError(
        nativeRuntimeError(
          'invalid_preview_demand',
          'Invalid local screen preview demand',
          { stage: 'screen_preview_demand' },
        ),
      ),
    )
  }
  return {
    demanded: demand.demanded,
    width: Math.max(16, Math.min(3840, Math.trunc(demand.width))),
    height: Math.max(16, Math.min(2160, Math.trunc(demand.height))),
    fps: Math.max(1, Math.min(60, Math.trunc(demand.fps))),
  }
})

const validateLocalCameraPreviewDemandEffect = Effect.fn(
  'nativeMedia.validateLocalCameraPreviewDemand',
)(function* (demanded: boolean) {
  if (typeof demanded !== 'boolean') {
    return yield* Effect.fail(
      new NativeRuntimeRequestError(
        nativeRuntimeError(
          'invalid_preview_demand',
          'Invalid local camera preview demand',
          { stage: 'camera_preview_demand' },
        ),
      ),
    )
  }
  return demanded
})

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

export type RemoteVideoPublication = {
  sessionId: string
  generation: number
  trackId: string
  participantIdentity: string
  source: 'camera' | 'screen'
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
  | {
      type: 'remoteVideoDemandFailed'
      sessionId: string
      generation: number
      trackId: string
      message: string
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
  source?: 'camera' | 'screen'
  demanded: boolean
  revision: number
  recoveryAttempt: number
  recoveryTimer: Fiber.Fiber<void, never> | null
  recoveryOperation: {
    fiber: Fiber.Fiber<boolean, unknown>
  } | null
  lastFrameAt: number | null
  recoveryStartedAt: number | null
  subscriptionFailure: boolean
  failureNotified: boolean
}

export class NativeMediaController {
  private readonly effectRuntime = ManagedRuntime.make(Layer.empty)
  private readonly listeners = new Set<(event: NativeMediaControllerEvent) => void>()
  private readonly unsubscribeRuntimeEvent: () => void
  private readonly unsubscribeRuntimeState: () => void
  private previewGeneration = 0
  private preview: PreviewSessionState | null = null
  private previewStartOperation: {
    fiber: Fiber.Fiber<void, unknown>
    promise: Promise<void>
  } | null = null
  private lastRestoredRestartCount = 0
  private disposed = false
  private activeScreen: { sessionId: string; generation: number } | null = null
  private activeCamera: { sessionId: string; generation: number } | null = null
  private activeVoiceSession: { sessionId: string; generation: number } | null = null
  private readonly remoteVideoPublications = new Map<
    string,
    RemoteVideoPublication
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
  private localCameraPreviewDemanded = true

  constructor(private readonly options: NativeMediaControllerOptions) {
    this.unsubscribeRuntimeEvent = options.supervisor.onEvent((event) =>
      event.type === 'input' || event.type === 'foregroundWindow'
        ? undefined
        : this.handleRuntimeEvent(event),
    )
    this.unsubscribeRuntimeState = options.supervisor.onStateChange((snapshot) =>
      this.handleSupervisorState(snapshot),
    )
  }

  subscribe(listener: (event: NativeMediaControllerEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start() {
    return this.effectRuntime.runPromise(this.startEffect())
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

  retryRuntime() {
    return this.effectRuntime.runPromise(
      Effect.gen({ self: this }, function*() {
        if (!this.options.runtimeAvailable()) return this.getRuntimeState()
        yield* this.options.supervisor.retryEffect()
        return this.getRuntimeState()
      }),
    )
  }

  supportsNativeScreenCapture() {
    return this.effectRuntime.runPromise(
      Effect.gen({ self: this }, function*() {
        if (!this.options.runtimeAvailable()) return false
        yield* this.startEffect()
        const snapshot = this.options.supervisor.getSnapshot()
        return snapshot.status === 'ready' &&
          Boolean(snapshot.ready?.capabilities.includes('screen'))
      }),
    )
  }

  listDevices(
    kind: 'audioinput' | 'audiooutput' | 'videoinput',
  ): Promise<NativeMediaDeviceInfo[]> {
    return this.effectRuntime.runPromise(
      Effect.gen({ self: this }, function*() {
        if (!this.options.runtimeAvailable()) return []
        const result = yield* this.requestEffect(
          { type: 'listDevices', kind },
          QUERY_TIMEOUT_MS,
        )
        return Array.isArray(result)
          ? result.filter(isNativeMediaDeviceInfo)
          : []
      }),
    )
  }

  listDisplaySourcePage(
    enumerationId: string,
    page: number,
  ): Promise<DesktopDisplayMediaSourcePage> {
    return this.effectRuntime.runPromise(
      this.listDisplaySourcePageEffect(enumerationId, page),
    )
  }

  listDisplaySourcePageEffect(enumerationId: string, page: number) {
    return Effect.gen({ self: this }, function*() {
      if (!this.options.runtimeAvailable()) {
        return { sources: [], page, hasPrevious: page > 0, hasNext: false }
      }
      const result = yield* this.requestEffect(
        {
          type: 'listDisplaySources',
          action: 'metadata',
          enumerationId,
          page,
          selfWindowHwnd: this.options.getSelfWindowHwnd(),
        },
        QUERY_TIMEOUT_MS,
      )
      const sources = Array.isArray(result)
        ? result.filter(isDesktopDisplayMediaSource)
        : []
      return {
        sources: sources.slice(0, DISPLAY_SOURCE_PAGE_SIZE),
        page,
        hasPrevious: page > 0,
        hasNext: sources.length > DISPLAY_SOURCE_PAGE_SIZE,
      }
    })
  }

  loadDisplaySourceVisual(
    enumerationId: string,
    sourceId: string,
  ): Promise<DesktopDisplayMediaSource | null> {
    return this.effectRuntime.runPromise(
      this.loadDisplaySourceVisualEffect(enumerationId, sourceId),
    )
  }

  loadDisplaySourceVisualEffect(enumerationId: string, sourceId: string) {
    return Effect.gen({ self: this }, function*() {
      if (!this.options.runtimeAvailable()) return null
      const result = yield* this.requestEffect(
        {
          type: 'listDisplaySources',
          action: 'thumbnail',
          enumerationId,
          sourceId,
          selfWindowHwnd: this.options.getSelfWindowHwnd(),
        },
        QUERY_TIMEOUT_MS,
      )
      if (!Array.isArray(result)) return null
      return result.find(isDesktopDisplayMediaSource) ?? null
    })
  }

  cancelDisplaySourceEnumeration(enumerationId: string): Promise<void> {
    return this.effectRuntime.runPromise(
      this.cancelDisplaySourceEnumerationEffect(enumerationId),
    )
  }

  cancelDisplaySourceEnumerationEffect(enumerationId: string) {
    return Effect.gen({ self: this }, function*() {
      if (!this.options.runtimeAvailable()) return
      yield* this.requestEffect(
        {
          type: 'listDisplaySources',
          action: 'cancel',
          enumerationId,
        },
        QUERY_TIMEOUT_MS,
      )
    })
  }

  startMicrophonePreview(): Promise<void> {
    if (this.preview?.status === 'running') return Promise.resolve()
    if (this.previewStartOperation) return this.previewStartOperation.promise
    const generation = ++this.previewGeneration
    let fiber: Fiber.Fiber<void, unknown>
    const effect = this.startMicrophonePreviewNowEffect(generation).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (this.previewStartOperation?.fiber === fiber) {
            this.previewStartOperation = null
          }
        }),
      ),
    )
    fiber = this.effectRuntime.runFork(effect)
    const operation = {
      fiber,
      promise: this.effectRuntime.runPromise(Fiber.join(fiber)),
    }
    this.previewStartOperation = operation
    return operation.promise
  }

  stopMicrophonePreview() {
    return this.effectRuntime.runPromise(
      Effect.gen({ self: this }, function*() {
        const preview = this.preview
        const hadPreview = Boolean(preview || this.previewStartOperation)
        this.preview = null
        this.previewStartOperation = null
        ++this.previewGeneration
        if (preview) {
          yield* this.requestEffect(
            {
              type: 'stopPreview',
              sessionId: preview.sessionId,
              generation: preview.generation,
            },
            STOP_TIMEOUT_MS,
          ).pipe(Effect.catch(() => Effect.void), Effect.asVoid)
        }
        if (hadPreview) {
          this.emit({
            type: 'microphonePreviewState',
            event: { status: 'stopped' },
          })
        }
      }),
    )
  }

  setRemoteVideoDemand(
    sessionId: string,
    generation: number,
    trackId: string,
    demanded: boolean,
  ) {
    return this.effectRuntime.runPromise(
      this.setRemoteVideoDemandEffect(
        sessionId,
        generation,
        trackId,
        demanded,
      ),
    )
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

  listRemoteVideoPublications(): RemoteVideoPublication[] {
    return [...this.remoteVideoPublications.values()].map((publication) => ({
      ...publication,
    }))
  }

  resetRemoteVideoDemands() {
    const now = Date.now()
    for (const [key, demand] of this.remoteVideoDemands) {
      this.cancelRemoteVideoRecoveryTimer(demand)
      demand.lastFrameAt = now
      this.armRemoteVideoRecovery(key, demand)
    }
  }

  recoverRemoteVideoDemand(
    sessionId: string,
    generation: number,
    trackId: string,
  ) {
    return this.effectRuntime.runPromise(
      this.recoverRemoteVideoDemandEffect(
        sessionId,
        generation,
        trackId,
      ),
    )
  }

  private recoverRemoteVideoDemandEffect(
    sessionId: string,
    generation: number,
    trackId: string,
  ) {
    return Effect.gen({ self: this }, function*() {
      const key = remoteVideoDemandKey(sessionId, generation, trackId)
      const desired = this.remoteVideoDemands.get(key)
      if (!desired?.demanded) return false
      if (desired.recoveryOperation) {
        return yield* Fiber.join(desired.recoveryOperation.fiber)
      }
      desired.recoveryAttempt += 1
      desired.recoveryStartedAt ??= Date.now()
      if (
        desired.recoveryAttempt >= REMOTE_VIDEO_DEGRADED_RECOVERY_ATTEMPT &&
        !desired.failureNotified
      ) {
        this.reportDegradedRemoteVideoDemand(desired)
      }
      this.options.diagnostics?.({
        scope: 'native-media-controller',
        event: 'remote_video_recovery_started',
        kind: desired.source ? `remote-${desired.source}` : 'remote-video',
        stage: 'native-state-aware-recovery',
        sessionId,
        generation,
        recoveryAttempt: desired.recoveryAttempt,
        reason: 'frame_timeout_or_pipeline_failure',
      })
      let fiber: Fiber.Fiber<boolean, unknown>
      const effect = this.performRemoteVideoRecoveryEffect(key, desired).pipe(
        Effect.catch((error) => {
          if (!isSupersededRequest(error)) return Effect.fail(error)
          return Effect.sync(() => {
            this.retireRemoteVideoDemand(key, desired)
            this.logSupersededDemand(desired, 'recoverRemoteVideoDemand')
            return false
          })
        }),
        Effect.ensuring(
          Effect.sync(() => {
            if (desired.recoveryOperation?.fiber === fiber) {
              desired.recoveryOperation = null
            }
          }),
        ),
      )
      fiber = this.effectRuntime.runFork(effect)
      desired.recoveryOperation = { fiber }
      return yield* Fiber.join(fiber)
    })
  }

  private setRemoteVideoDemandEffect(
    sessionId: string,
    generation: number,
    trackId: string,
    demanded: boolean,
  ) {
    return Effect.gen({ self: this }, function*() {
      if (!sessionId || !trackId) {
        return yield* Effect.fail(
          new Error('Remote video identity is required'),
        )
      }
      if (!this.isCurrentVoiceSession(sessionId, generation)) return
      const key = remoteVideoDemandKey(sessionId, generation, trackId)
      const previous = this.remoteVideoDemands.get(key)
      if (previous) this.cancelRemoteVideoRecoveryTimer(previous)
      const demand: RemoteVideoDemandState = {
        sessionId,
        generation,
        trackId,
        source: this.remoteVideoPublications.get(trackId)?.source,
        demanded,
        revision: ++this.remoteVideoDemandRevision,
        recoveryAttempt: 0,
        recoveryTimer: null,
        recoveryOperation: null,
        lastFrameAt: null,
        recoveryStartedAt: null,
        subscriptionFailure: false,
        failureNotified: false,
      }
      this.remoteVideoDemands.set(key, demand)
      this.armRemoteVideoRecovery(key, demand)
      yield* this.requestEffect(
        {
          type: 'setRemoteVideoDemand',
          sessionId,
          generation,
          trackId,
          demanded,
        },
        2_000,
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (!demanded && this.remoteVideoDemands.get(key) === demand) {
              this.remoteVideoDemands.delete(key)
            }
          }),
        ),
        Effect.catch((error) => {
          this.retireRemoteVideoDemand(key, demand)
          if (!isSupersededRequest(error)) return Effect.fail(error)
          return Effect.sync(() => {
            this.logSupersededDemand(demand, 'setRemoteVideoDemand')
          })
        }),
      )
    })
  }

  markRemoteVideoFramePresented(
    sessionId: string,
    generation: number,
    trackId: string,
  ) {
    const key = remoteVideoDemandKey(sessionId, generation, trackId)
    const demand = this.remoteVideoDemands.get(key)
    if (!demand?.demanded) return
    const now = Date.now()
    const firstFrame = demand.lastFrameAt === null
    const recoveryAttempt = demand.recoveryAttempt
    const recovered = recoveryAttempt > 0
    const durationMs = demand.recoveryStartedAt === null
      ? undefined
      : Math.max(0, now - demand.recoveryStartedAt)
    demand.lastFrameAt = now
    demand.recoveryAttempt = 0
    demand.recoveryStartedAt = null
    demand.subscriptionFailure = false
    demand.failureNotified = false
    if (firstFrame || recovered) {
      this.options.diagnostics?.({
        scope: 'native-media-controller',
        event: 'remote_video_frame_presented',
        kind: demand.source ? `remote-${demand.source}` : 'remote-video',
        stage: 'renderer-delivery',
        sessionId,
        generation,
        recoveryAttempt,
        outcome: recovered ? 'recovered' : 'first-frame',
        durationMs,
      })
    }
    if (!demand.recoveryTimer) this.armRemoteVideoRecovery(key, demand)
  }

  recoverLocalScreenPreview() {
    return this.effectRuntime.runPromise(
      Effect.gen({ self: this }, function*() {
        const screen = this.activeScreen
        const demand = this.localScreenPreviewDemand
        if (!screen || !demand.demanded) return false
        yield* this.requestEffect(
          {
            type: 'setLocalScreenPreviewDemand',
            ...screen,
            demanded: false,
            electronMainPid: this.options.processId ?? process.pid,
            options: {
              width: demand.width,
              height: demand.height,
              fps: demand.fps,
            },
          },
          2_000,
        )
        yield* this.sendLocalScreenPreviewDemandEffect(screen)
        return true
      }),
    )
  }

  recoverLocalCameraPreview() {
    return this.effectRuntime.runPromise(
      Effect.gen({ self: this }, function*() {
        const camera = this.activeCamera
        if (!camera || !this.localCameraPreviewDemanded) return false
        yield* this.requestEffect(
          {
            type: 'retryLocalCameraPreview',
            ...camera,
            reason: 'renderer_presentation_stall',
          },
          2_000,
        )
        return true
      }),
    )
  }

  private performRemoteVideoRecoveryEffect(
    key: string,
    desired: RemoteVideoDemandState,
  ) {
    return Effect.sync(() =>
      this.cancelRemoteVideoRecoveryTimer(desired)
    ).pipe(
      Effect.andThen(
        this.requestEffect(
          {
            type: 'retryRemoteVideo',
            sessionId: desired.sessionId,
            generation: desired.generation,
            trackId: desired.trackId,
            reason: 'frame_timeout_or_pipeline_failure',
          },
          2_000,
        ),
      ),
      Effect.map(() => {
        const current = this.remoteVideoDemands.get(key)
        return Boolean(
          current?.demanded &&
          current.revision === desired.revision,
        )
      }),
      Effect.ensuring(
        Effect.sync(() => {
          const current = this.remoteVideoDemands.get(key)
          if (current === desired && current.demanded) {
            this.armRemoteVideoRecovery(key, current)
          }
        }),
      ),
    )
  }

  setLocalScreenPreviewDemand(demand: LocalScreenPreviewDemand) {
    return this.effectRuntime.runPromise(
      Effect.gen({ self: this }, function*() {
        this.localScreenPreviewDemand =
          yield* normalizeLocalScreenPreviewDemandEffect(demand)
        const screen = this.activeScreen
        if (screen) yield* this.sendLocalScreenPreviewDemandEffect(screen)
      }),
    )
  }

  setLocalCameraPreviewDemand(demanded: boolean) {
    return this.effectRuntime.runPromise(
      Effect.gen({ self: this }, function*() {
        this.localCameraPreviewDemanded =
          yield* validateLocalCameraPreviewDemandEffect(demanded)
        const camera = this.activeCamera
        if (camera) yield* this.sendLocalCameraPreviewDemandEffect(camera)
      }),
    )
  }

  dispose() {
    return Effect.runPromise(this.disposeEffect())
  }

  disposeEffect() {
    return Effect.gen({ self: this }, function*() {
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
      this.remoteVideoPublications.clear()
      this.unsubscribeRuntimeEvent()
      this.unsubscribeRuntimeState()
      this.listeners.clear()
      yield* this.options.supervisor.shutdownEffect().pipe(
        Effect.catch(() => Effect.void),
      )
      yield* this.effectRuntime.disposeEffect
    })
  }

  startEffect() {
    return Effect.suspend(() => {
      if (!this.options.runtimeAvailable()) return Effect.void
      return this.options.supervisor.startEffect().pipe(Effect.asVoid)
    })
  }

  private startMicrophonePreviewNowEffect(generation: number) {
    return Effect.gen({ self: this }, function*() {
      yield* this.startEffect()
      if (generation !== this.previewGeneration) {
        return yield* Effect.fail(
          new Error('Native microphone preview start cancelled'),
        )
      }
      const preview: PreviewSessionState = {
        sessionId: crypto.randomUUID(),
        generation,
        status: 'starting',
      }
      this.preview = preview
      return yield* this.requestEffect(
        { type: 'startPreview', sessionId: preview.sessionId, generation },
        SESSION_TIMEOUT_MS,
      ).pipe(
        Effect.flatMap((result) =>
          Effect.gen({ self: this }, function*() {
            if (
              this.preview !== preview ||
              generation !== this.previewGeneration
            ) {
              yield* this.requestEffect(
                {
                  type: 'stopPreview',
                  sessionId: preview.sessionId,
                  generation,
                },
                STOP_TIMEOUT_MS,
              ).pipe(Effect.catch(() => Effect.void))
              return yield* Effect.fail(
                new Error('Native microphone preview start cancelled'),
              )
            }
            yield* Effect.sync(() => {
              readPreviewResult(result, preview.sessionId)
              preview.status = 'running'
              this.emit({
                type: 'microphonePreviewState',
                event: { status: 'running' },
              })
            })
          }),
        ),
        Effect.tapError(() =>
          Effect.sync(() => {
            if (this.preview === preview) this.preview = null
          }),
        ),
      )
    })
  }

  private requestEffect(command: MediaRuntimeCommand, timeoutMs: number) {
    return Effect.suspend(() => {
      if (this.disposed) {
        return Effect.fail(new Error('Native media controller is disposed'))
      }
      if (!isNativeRuntimeCommand(command)) {
        return Effect.fail(new Error('Invalid native runtime command'))
      }
      return this.options.supervisor.requestEffect(command, timeoutMs)
    })
  }

  private sendLocalScreenPreviewDemandEffect(
    screen: { sessionId: string; generation: number },
  ) {
    const demand = this.localScreenPreviewDemand
    return this.requestEffect(
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

  private sendLocalCameraPreviewDemandEffect(
    camera: { sessionId: string; generation: number },
  ) {
    return this.requestEffect(
      {
        type: 'setLocalCameraPreviewDemand',
        ...camera,
        demanded: this.localCameraPreviewDemanded,
      },
      2_000,
    )
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
      return
    }
    if (event.type === 'remoteVideoPublicationAvailable') {
      if (!this.isCurrentVoiceSession(event.sessionId, event.generation)) return
      this.remoteVideoPublications.set(event.trackId, {
        sessionId: event.sessionId,
        generation: event.generation,
        trackId: event.trackId,
        participantIdentity: event.participantIdentity,
        source: event.source,
      })
      return
    }
    if (event.type === 'remoteVideoPublicationUnavailable') {
      if (!this.isCurrentVoiceSession(event.sessionId, event.generation)) return
      this.remoteVideoPublications.delete(event.trackId)
      const key = remoteVideoDemandKey(
        event.sessionId,
        event.generation,
        event.trackId,
      )
      const demand = this.remoteVideoDemands.get(key)
      if (demand) this.cancelRemoteVideoRecoveryTimer(demand)
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
      if (demand?.demanded) {
        if (event.type === 'remoteVideoFailed' &&
          event.reason === 'subscription') {
          if (!demand.subscriptionFailure) demand.failureNotified = false
          demand.subscriptionFailure = true
        }
        this.armRemoteVideoRecovery(key, demand, true)
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
        if (changed) {
          this.effectRuntime.runFork(
            this.sendLocalScreenPreviewDemandEffect(next).pipe(
              Effect.catch(() => Effect.void),
              Effect.asVoid,
            ),
          )
        }
      } else if (this.activeScreen?.sessionId === event.sessionId &&
        event.generation >= this.activeScreen.generation) {
        this.activeScreen = null
      }
    }
    if (event.type === 'sessionLifecycle' && event.kind === 'camera') {
      if (event.state.status === 'starting' || event.state.status === 'running') {
        const next = { sessionId: event.sessionId, generation: event.generation }
        if (this.activeCamera && event.generation < this.activeCamera.generation) {
          return
        }
        const changed = this.activeCamera?.sessionId !== next.sessionId ||
          this.activeCamera.generation !== next.generation
        this.activeCamera = next
        if (changed) {
          this.effectRuntime.runFork(
            this.sendLocalCameraPreviewDemandEffect(next).pipe(
              Effect.catch(() => Effect.void),
              Effect.asVoid,
            ),
          )
        }
      } else if (this.activeCamera?.sessionId === event.sessionId &&
        event.generation >= this.activeCamera.generation) {
        this.activeCamera = null
      }
    }
    if (event.type === 'sessionStopped' && this.activeScreen?.sessionId === event.sessionId &&
      event.generation >= this.activeScreen.generation) {
      this.activeScreen = null
    }
    if (event.type === 'sessionStopped' && this.activeCamera?.sessionId === event.sessionId &&
      event.generation >= this.activeCamera.generation) {
      this.activeCamera = null
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
      this.activeCamera = null
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
    this.effectRuntime.runFork(
      this.requestEffect(
        {
          type: 'startPreview',
          sessionId: preview.sessionId,
          generation: preview.generation,
        },
        SESSION_TIMEOUT_MS,
      ).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            readPreviewResult(result, preview.sessionId)
            if (this.preview === preview) preview.status = 'running'
          })
        ),
        Effect.catch((error) =>
          Effect.sync(() => {
            if (this.preview !== preview) return
            this.preview = null
            this.emit({
              type: 'microphonePreviewState',
              event: {
                status: 'error',
                message:
                  error instanceof Error
                    ? error.message
                    : 'Native microphone preview recovery failed',
              },
            })
          })
        ),
        Effect.asVoid,
      ),
    )
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
      this.cancelRemoteVideoRecoveryTimer(demand)
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
    this.remoteVideoPublications.clear()
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
    this.cancelRemoteVideoRecoveryTimer(demand)
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
  ) {
    this.cancelRemoteVideoRecoveryTimer(demand)
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
    let fiber: Fiber.Fiber<void, never>
    const effect = Effect.sleep(timeout).pipe(
      Effect.andThen(
        Effect.gen({ self: this }, function*() {
          if (demand.recoveryTimer === fiber) demand.recoveryTimer = null
          if (
            this.remoteVideoDemands.get(key) !== demand ||
            !demand.demanded
          ) {
            return
          }
          if (
            !failureKnown &&
            demand.lastFrameAt !== null &&
            Date.now() - demand.lastFrameAt < baseTimeout
          ) {
            this.armRemoteVideoRecovery(key, demand)
            return
          }
          yield* this.recoverRemoteVideoDemandEffect(
            demand.sessionId,
            demand.generation,
            demand.trackId,
          ).pipe(
            Effect.catch(() =>
              Effect.sync(() => {
                if (
                  this.remoteVideoDemands.get(key) === demand &&
                  demand.demanded
                ) {
                  this.armRemoteVideoRecovery(key, demand, true)
                }
              })
            ),
            Effect.asVoid,
          )
        }),
      ),
    )
    fiber = this.effectRuntime.runFork(effect)
    demand.recoveryTimer = fiber
  }

  private cancelRemoteVideoRecoveryTimer(demand: RemoteVideoDemandState) {
    const timer = demand.recoveryTimer
    if (!timer) return
    demand.recoveryTimer = null
    this.effectRuntime.runFork(Fiber.interrupt(timer))
  }

  private reportDegradedRemoteVideoDemand(
    demand: RemoteVideoDemandState,
  ) {
    demand.failureNotified = true
    this.options.diagnostics?.({
      scope: 'native-media-controller',
      event: 'remote_video_recovery_degraded',
      kind: demand.source ? `remote-${demand.source}` : 'remote-video',
      stage: 'native-state-aware-recovery',
      sessionId: demand.sessionId,
      generation: demand.generation,
      recoveryAttempt: demand.recoveryAttempt,
      durationMs: demand.recoveryStartedAt === null
        ? undefined
        : Math.max(0, Date.now() - demand.recoveryStartedAt),
      reason: demand.subscriptionFailure
        ? 'subscription_recovery_budget_exceeded'
        : 'local_recovery_budget_exceeded',
    })
    if (!demand.subscriptionFailure) return
    this.emit({
      type: 'remoteVideoDemandFailed',
      sessionId: demand.sessionId,
      generation: demand.generation,
      trackId: demand.trackId,
      message: 'Не удалось подключиться к видеопотоку',
    })
  }

  private remoteVideoFirstFrameTimeout() {
    return Math.max(
      1_000,
      this.options.remoteVideoFirstFrameTimeoutMs ??
        REMOTE_VIDEO_FIRST_FRAME_TIMEOUT_MS,
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

const PreviewResultSchema = Schema.Union([
  Schema.Struct({ sessionId: Schema.String }),
  Schema.Struct({
    session: Schema.Struct({ sessionId: Schema.String }),
  }),
])

function readPreviewResult(value: unknown, sessionId: string) {
  const decoded = Schema.decodeUnknownOption(PreviewResultSchema)(value)
  if (Option.isNone(decoded)) {
    throw new Error('Native runtime returned invalid preview metadata')
  }
  const decodedSessionId = 'session' in decoded.value
    ? decoded.value.session.sessionId
    : decoded.value.sessionId
  if (decodedSessionId !== sessionId) {
    throw new Error('Native runtime returned invalid preview metadata')
  }
}

function isNativeMediaDeviceInfo(value: unknown): value is NativeMediaDeviceInfo {
  return Option.isSome(
    Schema.decodeUnknownOption(NativeMediaDeviceInfoSchema)(value),
  )
}

function isDesktopDisplayMediaSource(value: unknown): value is DesktopDisplayMediaSource {
  return Option.isSome(
    Schema.decodeUnknownOption(DesktopDisplayMediaSourceSchema)(value),
  )
}
