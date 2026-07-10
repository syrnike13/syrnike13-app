import type {
  DesktopDisplayMediaSource,
  NativeMediaDeviceInfo,
  NativeMediaEngineSessionSummary,
  NativeMediaMicrophoneSessionStartOptions,
  NativeMediaRuntimeLostEvent,
  NativeMediaScreenSessionPrepareOptions,
  NativeMediaSession,
  NativeMediaSessionKind,
  NativeMediaSessionStartOptions,
  NativeMediaState,
  NativeMediaStateEvent,
  NativeMediaStatsEvent,
  NativeMicrophonePipelineConfig,
  NativeMicrophoneMetricsEvent,
  NativeMicrophonePreviewStateEvent,
} from '@syrnike13/platform'
import type { DiagnosticLogSink } from './diagnostic-log'

import {
  isNativeMediaSession,
  isNativeRuntimeCommand,
  type MediaRuntimeCommand,
  type MediaRuntimeEvent,
} from './contract'
import {
  NativeRuntimeRequestError,
  type NativeRuntimeSupervisor,
  type NativeRuntimeSupervisorSnapshot,
} from './runtime-supervisor'

const QUERY_TIMEOUT_MS = 5_000
const SESSION_TIMEOUT_MS = 20_000
const STOP_TIMEOUT_MS = 5_000

const DEFAULT_MICROPHONE_PIPELINE_CONFIG: NativeMicrophonePipelineConfig = {
  deviceId: null,
  noiseSuppression: true,
  echoCancellation: true,
  inputVolume: 1,
  voiceGateEnabled: false,
  voiceGateThresholdDb: -45,
  voiceGateAutoThreshold: true,
}

type ActiveSession = {
  sessionId: string
  generation: number
  requestId: string
  options: NativeMediaSessionStartOptions
  status: 'starting' | 'running' | 'error'
  session?: NativeMediaSession
  effectiveMuted?: boolean
  candidateGeneration?: number
  stopOperation?: Promise<boolean>
}

type PreparedScreen = {
  sessionId: string
  generation: number
  options: NativeMediaScreenSessionPrepareOptions
  status: 'connecting' | 'ready'
}

type PreviewSessionState = {
  sessionId: string
  generation: number
  status: 'starting' | 'running'
}

type RecoveryDesiredState = {
  restartCount: number
  preview: PreviewSessionState | null
  microphonePipelineDesiredWarm: boolean
}

export type NativeMediaControllerEvent =
  | { type: 'state'; event: NativeMediaStateEvent }
  | { type: 'stats'; event: NativeMediaStatsEvent }
  | { type: 'microphoneMetrics'; event: NativeMicrophoneMetricsEvent }
  | { type: 'microphonePreviewState'; event: NativeMicrophonePreviewStateEvent }
  | { type: 'streamEnded'; sessionId: string }
  | { type: 'streamError'; event: { sessionId: string; message: string } }
  | {
      type: 'executionTerminal'
      event: {
        kind: NativeMediaSessionKind
        sessionId: string
        code: string
        stage: string
        retryable: boolean
      }
    }
  | { type: 'runtimeLost'; event: NativeMediaRuntimeLostEvent }
  | {
      type: 'operationMetric'
      operation: 'sessionStart'
      kind: NativeMediaSessionKind
      outcome: 'succeeded' | 'failed' | 'cancelled'
      durationMs: number
    }

export type NativeMediaControllerOptions = {
  supervisor: NativeRuntimeSupervisor
  runtimeAvailable: () => boolean
  getSelfWindowHwnd: () => string | undefined
  processId?: number
  diagnostics?: DiagnosticLogSink
}

export class NativeMediaController {
  private readonly sessions = new Map<string, ActiveSession>()
  private readonly listeners = new Set<(event: NativeMediaControllerEvent) => void>()
  private readonly queues: Record<NativeMediaSessionKind, Promise<unknown>> = {
    microphone: Promise.resolve(),
    screen: Promise.resolve(),
  }
  private readonly queueDepths: Record<NativeMediaSessionKind, number> = {
    microphone: 0,
    screen: 0,
  }
  private generations: Record<NativeMediaSessionKind | 'preview', number> = {
    microphone: 0,
    screen: 0,
    preview: 0,
  }
  private latestRequestIds: Partial<Record<NativeMediaSessionKind, string>> = {}
  private preparedScreen: PreparedScreen | null = null
  private screenTerminalOperation: Promise<void> = Promise.resolve()
  private preview: PreviewSessionState | null = null
  private previewStartOperation: Promise<void> | null = null
  private microphonePipelineConfig: NativeMicrophonePipelineConfig = {
    ...DEFAULT_MICROPHONE_PIPELINE_CONFIG,
  }
  private microphonePipelineRevision = 0
  private microphonePipelineGeneration = 0
  private microphonePipelineDesiredWarm = false
  private microphonePipelineWarm = false
  private microphonePipelineWarmOperation: Promise<void> | null = null
  private lastError: string | null = null
  private lastRestoredRestartCount = 0
  private lastNotifiedRestartCount = 0
  private recoveryDesiredState: RecoveryDesiredState | null = null
  private disposed = false

  constructor(private readonly options: NativeMediaControllerOptions) {
    options.supervisor.onEvent((event) => {
      this.handleRuntimeEvent(event as MediaRuntimeEvent)
    })
    options.supervisor.onStateChange((snapshot) => {
      this.handleSupervisorState(snapshot)
    })
  }

  subscribe(listener: (event: NativeMediaControllerEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start() {
    if (!this.options.runtimeAvailable()) return
    this.log('controller_start_requested', {
      pendingCount: this.supervisorPendingCount(),
    })
    await this.options.supervisor.start()
    this.log('controller_start_completed', {
      pendingCount: this.supervisorPendingCount(),
    })
  }

  async prewarmMicrophone() {
    if (!this.options.runtimeAvailable()) return
    this.microphonePipelineDesiredWarm = true
    this.log('microphone_prewarm_requested', {
      pendingCount: this.supervisorPendingCount(),
    })
    await this.ensureMicrophonePipelineWarm()
    this.log('microphone_prewarm_completed', {
      pendingCount: this.supervisorPendingCount(),
    })
  }

  async listDevices(kind: 'audioinput'): Promise<NativeMediaDeviceInfo[]> {
    if (!this.options.runtimeAvailable()) return []
    const result = await this.request<unknown>({ type: 'listDevices', kind }, QUERY_TIMEOUT_MS)
    return Array.isArray(result)
      ? result.filter(isNativeMediaDeviceInfo)
      : []
  }

  async listDisplaySources(): Promise<DesktopDisplayMediaSource[]> {
    if (!this.options.runtimeAvailable()) return []
    const result = await this.request<unknown>(
      {
        type: 'listDisplaySources',
        selfWindowHwnd: this.options.getSelfWindowHwnd(),
      },
      QUERY_TIMEOUT_MS,
    )
    return Array.isArray(result)
      ? result.filter(isDesktopDisplayMediaSource)
      : []
  }

  startMicrophonePreview(): Promise<void> {
    if (this.preview?.status === 'running') return Promise.resolve()
    if (this.previewStartOperation) return this.previewStartOperation

    const generation = ++this.generations.preview
    const operation = this.startMicrophonePreviewNow(generation)
    this.previewStartOperation = operation
    void operation.finally(() => {
      if (this.previewStartOperation === operation) {
        this.previewStartOperation = null
      }
    }).catch(() => undefined)
    return operation
  }

  private async startMicrophonePreviewNow(generation: number) {
    await this.start()
    this.microphonePipelineDesiredWarm = true
    await this.ensureMicrophonePipelineWarm()
    if (generation !== this.generations.preview) {
      throw new Error('Native microphone preview start cancelled')
    }
    const sessionId = crypto.randomUUID()
    const preview: PreviewSessionState = {
      sessionId,
      generation,
      status: 'starting',
    }
    this.preview = preview
    try {
      const result = await this.request<unknown>(
        { type: 'startPreview', sessionId, generation },
        // PreviewActor has its own 5 s startup deadline. The transport deadline
        // must leave enough margin for actor teardown and message delivery.
        SESSION_TIMEOUT_MS,
      )
      if (this.preview !== preview || generation !== this.generations.preview) {
        await this.request(
          { type: 'stopPreview', sessionId, generation },
          STOP_TIMEOUT_MS,
        ).catch(() => undefined)
        throw new Error('Native microphone preview start cancelled')
      }
      readPreviewResult(result, sessionId)
      preview.status = 'running'
      this.emit({
        type: 'microphonePreviewState',
        event: { status: 'running' },
      })
    } catch (error) {
      if (this.preview === preview) this.preview = null
      throw error
    }
  }

  async stopMicrophonePreview() {
    const preview = this.preview
    const hadPreviewIntent = Boolean(preview || this.previewStartOperation)
    this.preview = null
    this.previewStartOperation = null
    const stoppedGeneration = ++this.generations.preview
    if (preview) {
      await this.request(
        {
          type: 'stopPreview',
          sessionId: preview.sessionId,
          generation: preview.generation,
        },
        STOP_TIMEOUT_MS,
      ).catch(() => undefined)
    }
    if (
      hadPreviewIntent &&
      stoppedGeneration === this.generations.preview &&
      !this.preview
    ) {
      this.emit({
        type: 'microphonePreviewState',
        event: { status: 'stopped' },
      })
    }
  }

  prepareScreenSession(options: NativeMediaScreenSessionPrepareOptions) {
    return this.enqueue('screen', 'prepare_screen', () =>
      this.prepareScreenSessionNow(options),
    )
  }

  private async prepareScreenSessionNow(
    options: NativeMediaScreenSessionPrepareOptions,
  ) {
    await this.screenTerminalOperation
    const active = Array.from(this.sessions.values()).find(
      (session) => session.options.kind === 'screen',
    )
    if (active) {
      if (
        sameScreenLiveKitConnection({ livekit: active.options.livekit }, options)
      ) {
        return
      }
      throw new Error('Cannot prepare a screen session while screen sharing is active')
    }
    const current = this.preparedScreen
    if (
      current?.status === 'ready' &&
      sameScreenLiveKitConnection(current.options, options)
    ) {
      return
    }
    if (current) await this.disconnectPreparedScreenSessionNow()
    const generation = ++this.generations.screen
    const sessionId = crypto.randomUUID()
    const prepared = {
      sessionId,
      generation,
      options,
      status: 'connecting' as const,
    }
    this.preparedScreen = prepared
    try {
      await this.request(
        { type: 'connectScreen', sessionId, generation, options },
        SESSION_TIMEOUT_MS,
      )
      if (this.preparedScreen === prepared) {
        this.preparedScreen = { ...prepared, status: 'ready' }
      }
    } catch (error) {
      if (this.preparedScreen?.sessionId === sessionId) this.preparedScreen = null
      throw error
    }
  }

  disconnectPreparedScreenSession() {
    return this.enqueue('screen', 'disconnect_prepared_screen', () =>
      this.disconnectPreparedScreenSessionNow(),
    )
  }

  private async disconnectPreparedScreenSessionNow() {
    const prepared = this.preparedScreen
    if (!prepared) return
    await this.request(
      {
        type: 'disconnectScreen',
        sessionId: prepared.sessionId,
        generation: prepared.generation,
      },
      STOP_TIMEOUT_MS,
    )
    if (this.preparedScreen === prepared) this.preparedScreen = null
  }

  startSession(options: NativeMediaSessionStartOptions) {
    assertSessionStartOptions(options, this.options.getSelfWindowHwnd())
    void this.cancelPendingStarts(options.kind)
    this.latestRequestIds[options.kind] = options.requestId
    return this.enqueue(options.kind, `start_${options.kind}`, () =>
      this.startSessionNow(options),
    )
  }

  async cancelPendingStarts(kind?: NativeMediaSessionKind) {
    const kinds: NativeMediaSessionKind[] = kind ? [kind] : ['microphone', 'screen']
    const invalidations: Promise<unknown>[] = []
    for (const currentKind of kinds) {
      this.latestRequestIds[currentKind] = undefined
      this.generations[currentKind] += 1
      for (const session of Array.from(this.sessions.values())) {
        if (session.options.kind !== currentKind) continue
        if (session.status === 'starting') {
          void this.retireSession(session).catch(() => undefined)
          continue
        }
        if (
          currentKind === 'microphone' &&
          session.candidateGeneration !== undefined
        ) {
          const cancelledCandidateGeneration = session.candidateGeneration
          const fenceGeneration = this.generations.microphone
          session.candidateGeneration = undefined
          this.log('microphone_reconnect_superseded', {
            sessionId: session.sessionId,
            generation: session.generation,
            candidateGeneration: cancelledCandidateGeneration,
            fenceGeneration,
            pendingCount: this.supervisorPendingCount(),
          })
          invalidations.push(
            this.request(
              {
                type: 'invalidateMicrophone',
                sessionId: session.sessionId,
                generation: fenceGeneration,
              },
              QUERY_TIMEOUT_MS,
            ),
          )
        }
      }
    }
    await Promise.allSettled(invalidations)
  }

  async configureMicrophonePipeline(config: NativeMicrophonePipelineConfig) {
    const revision = this.microphonePipelineRevision + 1
    const command: MediaRuntimeCommand = {
      type: 'configureMicrophone',
      revision,
      config,
    }
    if (!isNativeRuntimeCommand(command)) {
      throw new Error('Invalid native microphone pipeline configuration')
    }

    this.microphonePipelineRevision = revision
    this.microphonePipelineConfig = { ...config }
    this.microphonePipelineDesiredWarm = true
    this.log('microphone_config_requested', {
      revision,
      pendingCount: this.supervisorPendingCount(),
    })
    if (!this.options.runtimeAvailable()) return

    await this.start()
    await this.ensureMicrophonePipelineWarm()
    if (revision !== this.microphonePipelineRevision) {
      this.log('microphone_config_superseded', {
        revision,
        pendingCount: this.supervisorPendingCount(),
      })
      return
    }
    await this.request(command, QUERY_TIMEOUT_MS)
    this.log('microphone_config_completed', {
      revision,
      pendingCount: this.supervisorPendingCount(),
    })
  }

  async setMicrophoneMuted(sessionId: string, muted: boolean) {
    const session = this.requireMicrophoneSession(sessionId)
    const generation = session.generation
    this.log('microphone_mute_requested', {
      sessionId,
      generation,
      muted,
      queueDepth: this.queueDepths.microphone,
      bypassedQueue: true,
      pendingCount: this.supervisorPendingCount(),
    })
    try {
      await this.request(
        {
          type: 'setMicrophoneMuted',
          sessionId,
          generation,
          muted,
        },
        QUERY_TIMEOUT_MS,
      )
      session.effectiveMuted = muted
      this.log('microphone_mute_completed', {
        sessionId,
        generation,
        muted,
        queueDepth: this.queueDepths.microphone,
        bypassedQueue: true,
        pendingCount: this.supervisorPendingCount(),
      })
    } catch (error) {
      this.log('microphone_mute_failed', {
        sessionId,
        generation,
        muted,
        queueDepth: this.queueDepths.microphone,
        bypassedQueue: true,
        pendingCount: this.supervisorPendingCount(),
        message: error instanceof Error ? error.message : 'Unknown error',
      })
      throw error
    }
  }

  reconnectMicrophoneSession(
    sessionId: string,
    options: NativeMediaMicrophoneSessionStartOptions,
  ) {
    const session = this.requireMicrophoneSession(sessionId)
    assertSessionStartOptions(options, undefined)
    this.latestRequestIds.microphone = options.requestId
    const generation = ++this.generations.microphone
    this.log('microphone_reconnect_requested', {
      sessionId,
      generation: session.generation,
      candidateGeneration: generation,
      requestId: options.requestId,
      muted: options.muted,
      pendingCount: this.supervisorPendingCount(),
    })
    const invalidated = this.request(
      {
        type: 'invalidateMicrophone',
        sessionId: session.sessionId,
        generation,
      },
      QUERY_TIMEOUT_MS,
    )
    invalidated.then(
      () =>
        this.log('microphone_reconnect_invalidated', {
          sessionId,
          generation: session.generation,
          candidateGeneration: generation,
          requestId: options.requestId,
          pendingCount: this.supervisorPendingCount(),
        }),
      (error) =>
        this.log('microphone_reconnect_invalidation_failed', {
          sessionId,
          generation: session.generation,
          candidateGeneration: generation,
          requestId: options.requestId,
          pendingCount: this.supervisorPendingCount(),
          message: error instanceof Error ? error.message : 'Unknown error',
        }),
    )
    void invalidated.catch(() => undefined)
    return this.enqueue('microphone', 'reconnect_microphone', () =>
      invalidated.then(() =>
        this.reconnectMicrophoneNow(sessionId, options, generation),
      ),
    )
  }

  async stopSession(sessionId?: string) {
    this.log('session_stop_requested', {
      sessionId,
      pendingCount: this.supervisorPendingCount(),
    })
    const selected = sessionId
      ? [this.sessions.get(sessionId)].filter((value): value is ActiveSession => Boolean(value))
      : Array.from(this.sessions.values())
    if (sessionId && selected.length === 0) return
    for (const session of selected) {
      const ownsRetirement = !session.stopOperation
      const endedOwnedSession = await this.retireSession(session)
      if (ownsRetirement && endedOwnedSession) {
        this.emit({ type: 'streamEnded', sessionId: session.sessionId })
        this.log('session_stop_completed', {
          sessionId: session.sessionId,
          generation: session.generation,
          kind: session.options.kind,
          pendingCount: this.supervisorPendingCount(),
        })
      }
    }
  }

  getState(): NativeMediaState {
    const supervisor = this.options.supervisor.getSnapshot()
    const sessions = Array.from(this.sessions.values())
    const primary =
      sessions.find((session) => session.options.kind === 'screen') ??
      sessions[0]
    const status = primary
      ? statusForSession(primary)
      : this.lastError
        ? ({ status: 'error', message: this.lastError } as const)
        : ({ status: 'idle' } as const)
    return {
      ...status,
      engine: {
        available: process.platform === 'win32' && this.options.runtimeAvailable(),
        runtime: {
          available: this.options.runtimeAvailable(),
          status: supervisor.status,
          pid: supervisor.pid,
          restartCount: supervisor.restartCount,
          degradedReason: supervisor.degradedReason,
        },
        capabilities: {
          screen: supervisor.ready?.capabilities.includes('screen') ?? false,
          systemAudio: supervisor.ready?.capabilities.includes('screenAudio') ?? false,
          microphone: supervisor.ready?.capabilities.includes('microphone') ?? false,
          camera: false,
        },
        activeSessions: sessions.map(sessionSummary),
        lastError: this.lastError,
      },
    }
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.microphonePipelineDesiredWarm = false
    this.microphonePipelineWarm = false
    this.microphonePipelineGeneration += 1
    this.microphonePipelineWarmOperation = null
    this.preparedScreen = null
    this.preview = null
    this.previewStartOperation = null
    this.sessions.clear()
    this.log('controller_disposed', {
      pendingCount: this.supervisorPendingCount(),
    })
    await this.options.supervisor.shutdown()
  }

  private async startSessionNow(
    options: NativeMediaSessionStartOptions,
  ): Promise<NativeMediaSession> {
    const operationStartedAt = performance.now()
    this.log('session_start_requested', {
      kind: options.kind,
      requestId: options.requestId,
      muted: options.kind === 'microphone' ? options.muted : undefined,
      pendingCount: this.supervisorPendingCount(),
    })
    this.assertCurrentRequest(options.kind, options.requestId)
    if (options.kind === 'screen') await this.screenTerminalOperation
    if (options.kind === 'microphone') {
      this.microphonePipelineDesiredWarm = true
      await this.ensureMicrophonePipelineWarm()
    }
    await this.stopKind(options.kind)
    this.assertCurrentRequest(options.kind, options.requestId)

    let preparedForStart: PreparedScreen | null = null
    if (options.kind === 'screen' && this.preparedScreen) {
      if (
        this.preparedScreen.status === 'ready' &&
        sameScreenLiveKitConnection(this.preparedScreen.options, {
          livekit: options.livekit,
        })
      ) {
        preparedForStart = this.preparedScreen
        this.preparedScreen = null
      } else {
        await this.disconnectPreparedScreenSessionNow()
      }
    }
    this.assertCurrentRequest(options.kind, options.requestId)
    const generation =
      options.kind === 'screen'
        ? ++this.generations.screen
        : ++this.generations[options.kind]
    const sessionId = preparedForStart?.sessionId ?? crypto.randomUUID()
    const active: ActiveSession = {
      sessionId,
      generation,
      requestId: options.requestId,
      options,
      status: 'starting',
      effectiveMuted: options.kind === 'microphone' ? options.muted : undefined,
    }
    this.sessions.set(sessionId, active)
    this.log('session_start_connecting', {
      kind: options.kind,
      requestId: options.requestId,
      sessionId,
      generation,
      muted: active.effectiveMuted,
      pendingCount: this.supervisorPendingCount(),
    })
    this.emit({ type: 'state', event: { status: 'starting', sessionId } })

    const command: MediaRuntimeCommand =
      options.kind === 'microphone'
        ? {
            type: 'connectMicrophone',
            sessionId,
            generation,
            options,
            excludeProcessId: this.options.processId ?? process.pid,
          }
        : {
            type: 'startScreenCapture',
            sessionId,
            generation,
            options,
            selfWindowHwnd: this.options.getSelfWindowHwnd(),
            excludeProcessId: this.options.processId ?? process.pid,
          }
    try {
      const result = await this.request<unknown>(command, SESSION_TIMEOUT_MS)
      this.assertCurrentRequest(options.kind, options.requestId)
      if (this.sessions.get(sessionId) !== active || active.generation !== generation) {
        throw new Error(`Native ${options.kind} start cancelled`)
      }
      const session = readSessionResult(result, sessionId, options)
      active.status = 'running'
      active.session = session
      this.lastError = null
      this.log('session_start_completed', {
        kind: options.kind,
        requestId: options.requestId,
        sessionId,
        generation,
        durationMs: performance.now() - operationStartedAt,
        pendingCount: this.supervisorPendingCount(),
      })
      this.emit({ type: 'state', event: stateForSession(session) })
      this.emit({
        type: 'operationMetric',
        operation: 'sessionStart',
        kind: options.kind,
        outcome: 'succeeded',
        durationMs: performance.now() - operationStartedAt,
      })
      return session
    } catch (error) {
      // A lost host owns no resources that can be cleaned up. Replaying a
      // stale disconnect after the replacement host becomes ready would fence
      // the reconciler's newer desired publication instead.
      if (isRuntimeGone(error)) {
        if (this.sessions.get(sessionId) === active) this.sessions.delete(sessionId)
      } else {
        void this.retireSession(active).catch(() => undefined)
      }
      this.log('session_start_failed', {
        kind: options.kind,
        requestId: options.requestId,
        sessionId,
        generation,
        durationMs: performance.now() - operationStartedAt,
        pendingCount: this.supervisorPendingCount(),
        message: error instanceof Error ? error.message : 'Unknown error',
      })
      this.emit({
        type: 'operationMetric',
        operation: 'sessionStart',
        kind: options.kind,
        outcome: isCancelledOperation(error) ? 'cancelled' : 'failed',
        durationMs: performance.now() - operationStartedAt,
      })
      throw error
    }
  }

  private async reconnectMicrophoneNow(
    sessionId: string,
    options: NativeMediaMicrophoneSessionStartOptions,
    generation: number,
  ): Promise<NativeMediaSession> {
    const session = this.requireMicrophoneSession(sessionId)
    this.assertCurrentRequest('microphone', options.requestId)
    const previousGeneration = session.generation
    session.candidateGeneration = generation
    this.log('microphone_reconnect_started', {
      sessionId,
      generation: previousGeneration,
      candidateGeneration: generation,
      requestId: options.requestId,
      muted: session.effectiveMuted ?? options.muted,
      pendingCount: this.supervisorPendingCount(),
    })
    let nativeCommitted = false
    try {
      const result = await this.request<unknown>(
        {
          type: 'connectMicrophone',
          sessionId,
          generation,
          options: {
            ...options,
            muted: session.effectiveMuted ?? options.muted,
          },
          excludeProcessId: this.options.processId ?? process.pid,
        },
        SESSION_TIMEOUT_MS,
      )
      if (
        this.sessions.get(sessionId) !== session ||
        session.candidateGeneration !== generation
      ) {
        throw new Error('Native microphone reconnect cancelled')
      }
      const next = readSessionResult(result, sessionId, options)
      if (next.kind !== 'microphone') {
        throw new Error('Native runtime returned a non-microphone session')
      }
      nativeCommitted = true
      session.generation = generation
      session.candidateGeneration = undefined
      session.requestId = options.requestId
      session.options = options
      session.session = next
      session.status = 'running'
      this.lastError = null
      this.log('microphone_reconnect_completed', {
        sessionId,
        generation,
        requestId: options.requestId,
        muted: session.effectiveMuted,
        pendingCount: this.supervisorPendingCount(),
      })
      return next
    } catch (error) {
      if (
        !nativeCommitted &&
        this.sessions.get(sessionId) === session &&
        session.candidateGeneration === generation
      ) {
        session.generation = previousGeneration
        session.candidateGeneration = undefined
      }
      this.log('microphone_reconnect_failed', {
        sessionId,
        generation: previousGeneration,
        candidateGeneration: generation,
        requestId: options.requestId,
        pendingCount: this.supervisorPendingCount(),
        message: error instanceof Error ? error.message : 'Unknown error',
      })
      throw error
    }
  }

  private async stopKind(kind: NativeMediaSessionKind) {
    for (const session of Array.from(this.sessions.values())) {
      if (session.options.kind !== kind) continue
      await this.retireSession(session)
    }
  }

  private retireSession(session: ActiveSession) {
    if (session.stopOperation) return session.stopOperation
    const operation = this.stopNativeSession(session).then(
      () => {
        const stillOwned = this.sessions.get(session.sessionId) === session
        if (stillOwned) this.sessions.delete(session.sessionId)
        return stillOwned
      },
      (error) => {
        if (this.sessions.get(session.sessionId) === session) {
          session.status = 'error'
          session.stopOperation = undefined
        }
        throw error
      },
    )
    session.stopOperation = operation
    return operation
  }

  private async stopNativeSession(session: ActiveSession) {
    const generation = ++this.generations[session.options.kind]
    this.log('native_stop_requested', {
      kind: session.options.kind,
      sessionId: session.sessionId,
      generation,
      pendingCount: this.supervisorPendingCount(),
    })
    if (session.options.kind === 'microphone') {
      await this.request(
        {
          type: 'disconnectMicrophone',
          sessionId: session.sessionId,
          generation,
        },
        STOP_TIMEOUT_MS,
      )
      this.log('native_stop_completed', {
        kind: session.options.kind,
        sessionId: session.sessionId,
        generation,
        pendingCount: this.supervisorPendingCount(),
      })
      return
    }
    const operation = this.stopNativeScreenSession(session.sessionId, generation)
    this.screenTerminalOperation = Promise.allSettled([
      this.screenTerminalOperation,
      operation,
    ]).then(() => undefined)
    void operation.then(
      () =>
        this.log('native_stop_completed', {
          kind: session.options.kind,
          sessionId: session.sessionId,
          generation,
          pendingCount: this.supervisorPendingCount(),
        }),
      (error) =>
        this.log('native_stop_failed', {
          kind: session.options.kind,
          sessionId: session.sessionId,
          generation,
          pendingCount: this.supervisorPendingCount(),
          message: error instanceof Error ? error.message : 'Unknown error',
        }),
    )
    return operation
  }

  private async stopNativeScreenSession(sessionId: string, generation: number) {
    let failure: unknown
    try {
      await this.request(
        { type: 'stopScreenCapture', sessionId, generation },
        STOP_TIMEOUT_MS,
      )
    } catch (error) {
      failure = error
    }
    try {
      await this.request(
        { type: 'disconnectScreen', sessionId, generation, terminal: true },
        STOP_TIMEOUT_MS,
      )
    } catch (error) {
      failure ??= error
    }
    if (failure) throw failure
  }

  private enqueue<T>(
    kind: NativeMediaSessionKind,
    operation: string,
    task: () => Promise<T>,
  ) {
    const enqueuedAt = performance.now()
    this.queueDepths[kind] += 1
    this.log('controller_queue_enqueued', {
      kind,
      operation,
      queueDepth: this.queueDepths[kind],
      pendingCount: this.supervisorPendingCount(),
    })
    const result = this.queues[kind].then(async () => {
      const startedAt = performance.now()
      this.log('controller_queue_started', {
        kind,
        operation,
        queueDepth: this.queueDepths[kind],
        queueWaitMs: startedAt - enqueuedAt,
        pendingCount: this.supervisorPendingCount(),
      })
      try {
        return await task()
      } finally {
        this.queueDepths[kind] -= 1
        this.log('controller_queue_finished', {
          kind,
          operation,
          queueDepth: this.queueDepths[kind],
          durationMs: performance.now() - startedAt,
          pendingCount: this.supervisorPendingCount(),
        })
      }
    })
    this.queues[kind] = result.catch(() => undefined)
    return result
  }

  private assertCurrentRequest(kind: NativeMediaSessionKind, requestId: string) {
    if (this.latestRequestIds[kind] !== requestId) {
      throw new Error(`Native ${kind} start cancelled`)
    }
  }

  private requireMicrophoneSession(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (!session || session.options.kind !== 'microphone') {
      throw new Error('Native microphone runtime is not active')
    }
    return session
  }

  private ensureMicrophonePipelineWarm() {
    if (this.microphonePipelineWarm) return Promise.resolve()
    if (this.microphonePipelineWarmOperation) {
      return this.microphonePipelineWarmOperation
    }

    const generation = ++this.microphonePipelineGeneration
    const config = { ...this.microphonePipelineConfig }
    const operation = this.request(
      {
        type: 'warmMicrophone',
        generation,
        config,
      },
      SESSION_TIMEOUT_MS,
    ).then(() => {
      if (generation === this.microphonePipelineGeneration) {
        this.microphonePipelineWarm = true
      }
    })
    this.microphonePipelineWarmOperation = operation
    void operation.finally(() => {
      if (this.microphonePipelineWarmOperation === operation) {
        this.microphonePipelineWarmOperation = null
      }
    }).catch(() => undefined)
    return operation
  }

  private request<T = unknown>(command: MediaRuntimeCommand, timeoutMs: number) {
    if (this.disposed) {
      return Promise.reject(new Error('Native media controller is disposed'))
    }
    if (!isNativeRuntimeCommand(command)) {
      return Promise.reject(new Error('Invalid native runtime command'))
    }
    return this.options.supervisor.request<T>(command, timeoutMs)
  }

  private handleRuntimeEvent(event: MediaRuntimeEvent) {
    if (event.type === 'runtimeError') {
      const sessionId = event.error.sessionId
      const preview = this.preview
      if (
        preview &&
        sessionId === preview.sessionId &&
        event.error.generation === preview.generation
      ) {
        this.preview = null
        this.previewStartOperation = null
        this.generations.preview += 1
        this.lastError = event.error.message
        this.emit({
          type: 'microphonePreviewState',
          event: { status: 'error', message: event.error.message },
        })
        return
      }
      const session = sessionId ? this.sessions.get(sessionId) : undefined
      if (
        session &&
        event.error.generation !== undefined &&
        event.error.generation === session.candidateGeneration
      ) {
        return
      }
      if (
        sessionId &&
        (!session ||
          (event.error.generation !== undefined &&
            event.error.generation !== session.generation))
      ) {
        return
      }
      this.lastError = event.error.message
      if (
        session &&
        (event.error.generation === undefined ||
          event.error.generation === session.generation)
      ) {
        this.emit({
          type: 'executionTerminal',
          event: {
            kind: session.options.kind,
            sessionId: session.sessionId,
            code: event.error.code,
            stage: event.error.stage ?? 'runtime',
            retryable: event.error.retryable,
          },
        })
        this.emit({
          type: 'streamError',
          event: { sessionId: session.sessionId, message: event.error.message },
        })
      }
      return
    }
    if (event.type === 'deviceList' || event.type === 'displaySourceList') return
    if (event.type === 'microphoneMetrics') {
      this.emit({ type: 'microphoneMetrics', event: event.metrics })
      return
    }
    const preview = this.preview
    if (
      preview &&
      event.sessionId === preview.sessionId &&
      event.generation === preview.generation
    ) {
      if (event.type === 'sessionStopped') {
        this.preview = null
        this.previewStartOperation = null
        this.generations.preview += 1
        this.emit({
          type: 'microphonePreviewState',
          event: { status: 'stopped' },
        })
        return
      }
      if (event.type === 'microphonePreviewStarted') return
    }
    const session = this.sessions.get(event.sessionId)
    if (!session || session.generation !== event.generation) return

    switch (event.type) {
      case 'sessionLifecycle':
        this.emit({ type: 'state', event: event.state })
        if (event.state.status === 'error') {
          session.status = 'error'
          this.lastError = event.state.message
          this.emit({
            type: 'executionTerminal',
            event: {
              kind: session.options.kind,
              sessionId: event.sessionId,
              code: 'native_terminal',
              stage: 'lifecycle',
              retryable: true,
            },
          })
          this.emit({
            type: 'streamError',
            event: { sessionId: event.sessionId, message: event.state.message },
          })
        }
        return
      case 'sessionStarted':
        session.status = 'running'
        session.session = event.session
        return
      case 'sessionStopped':
        this.sessions.delete(event.sessionId)
        this.emit({ type: 'streamEnded', sessionId: event.sessionId })
        return
      case 'stats':
        this.emit({ type: 'stats', event: event.stats })
        return
      case 'microphonePreviewStarted':
        return
      case 'screenCaptureEnded':
        this.sessions.delete(event.sessionId)
        this.emit({
          type: 'executionTerminal',
          event: {
            kind: 'screen',
            sessionId: event.sessionId,
            code: event.reason,
            stage: 'capture',
            retryable: event.reason !== 'target_closed',
          },
        })
        if (event.message) {
          this.emit({
            type: 'streamError',
            event: { sessionId: event.sessionId, message: event.message },
          })
        }
        this.emit({ type: 'streamEnded', sessionId: event.sessionId })
        return
    }
  }

  private handleSupervisorState(snapshot: NativeRuntimeSupervisorSnapshot) {
    if (
      snapshot.status === 'recovering' &&
      snapshot.restartCount > this.lastNotifiedRestartCount
    ) {
      this.lastNotifiedRestartCount = snapshot.restartCount
      this.microphonePipelineWarm = false
      this.microphonePipelineGeneration += 1
      this.microphonePipelineWarmOperation = null
      this.recoveryDesiredState = this.captureRecoveryDesiredState(
        snapshot.restartCount,
      )
      const message = snapshot.lastFailure ?? 'Native media runtime is recovering'
      this.log('controller_recovery_started', {
        restartCount: snapshot.restartCount,
        message,
        pendingCount: this.supervisorPendingCount(),
      })
      const reason = isHandshakeFailure(message) ? 'handshake_failed' : 'exit'
      for (const session of this.sessions.values()) {
        this.emit({
          type: 'runtimeLost',
          event: {
            sessionId: session.sessionId,
            reason,
            message,
            recovering: true,
          },
        })
      }
      this.sessions.clear()
      this.preparedScreen = null
      this.latestRequestIds = {}
      this.generations.microphone += 1
      this.generations.screen += 1
    }
    if (
      snapshot.status === 'ready' &&
      snapshot.restartCount > this.lastRestoredRestartCount
    ) {
      this.lastRestoredRestartCount = snapshot.restartCount
      const desired = this.recoveryDesiredState
      this.recoveryDesiredState = null
      if (desired?.restartCount === snapshot.restartCount) {
        this.log('controller_recovery_restoring', {
          restartCount: snapshot.restartCount,
          pendingCount: this.supervisorPendingCount(),
        })
        void this.restoreDesiredState(desired)
      }
      return
    }
    if (snapshot.status !== 'degraded') return
    this.recoveryDesiredState = null
    const message = snapshot.degradedReason ?? 'Native media runtime is unavailable'
    const reason = isHandshakeFailure(message)
      ? 'handshake_failed'
      : 'circuit_open'
    this.lastError = message
    this.log('controller_recovery_degraded', {
      restartCount: snapshot.restartCount,
      message,
      reason,
      pendingCount: this.supervisorPendingCount(),
    })
    this.microphonePipelineWarm = false
    this.microphonePipelineGeneration += 1
    this.microphonePipelineWarmOperation = null
    this.preparedScreen = null
    const previewWasActive = Boolean(this.preview || this.previewStartOperation)
    this.preview = null
    this.previewStartOperation = null
    this.generations.preview += 1
    if (previewWasActive) {
      this.emit({
        type: 'microphonePreviewState',
        event: { status: 'error', message },
      })
    }
    for (const session of Array.from(this.sessions.values())) {
      this.sessions.delete(session.sessionId)
      this.emit({
        type: 'runtimeLost',
        event: {
          sessionId: session.sessionId,
          reason,
          message,
          recovering: false,
        },
      })
      this.emit({
        type: 'streamError',
        event: { sessionId: session.sessionId, message },
      })
      this.emit({ type: 'streamEnded', sessionId: session.sessionId })
    }
  }

  private captureRecoveryDesiredState(restartCount: number): RecoveryDesiredState {
    return {
      restartCount,
      preview: this.preview?.status === 'running' ? this.preview : null,
      microphonePipelineDesiredWarm: this.microphonePipelineDesiredWarm,
    }
  }

  private async restoreDesiredState(desired: RecoveryDesiredState) {
    if (this.disposed) return
    const restorePreview = async () => {
      const preview = desired.preview
      if (
        !preview ||
        this.preview !== preview ||
        preview.status !== 'running'
      ) {
        return
      }
      const generation = ++this.generations.preview
      preview.generation = generation
      try {
        await this.request(
          {
            type: 'startPreview',
            sessionId: preview.sessionId,
            generation,
          },
          SESSION_TIMEOUT_MS,
        )
      } catch (error) {
        if (
          !isRecoverableRuntimeFailure(error) &&
          this.preview === preview &&
          preview.generation === generation
        ) {
          this.preview = null
          this.previewStartOperation = null
          this.generations.preview += 1
          this.lastError =
            error instanceof Error
              ? error.message
              : 'Native microphone preview recovery failed'
          this.emit({
            type: 'microphonePreviewState',
            event: { status: 'error', message: this.lastError },
          })
        }
      }
    }
    await this.enqueue('microphone', 'recover_pipeline_preview', async () => {
      if (
        desired.microphonePipelineDesiredWarm &&
        this.microphonePipelineDesiredWarm
      ) {
        await this.ensureMicrophonePipelineWarm().catch(() => undefined)
      }
      await restorePreview()
    })
  }

  private emit(event: NativeMediaControllerEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // Native execution and recovery must not depend on renderer observers.
      }
    }
  }

  private supervisorPendingCount() {
    return 'getPendingRequestCount' in this.options.supervisor &&
      typeof this.options.supervisor.getPendingRequestCount === 'function'
      ? this.options.supervisor.getPendingRequestCount()
      : undefined
  }

  private log(
    event: string,
    detail: {
      kind?: string
      operation?: string
      stage?: string
      sessionId?: string
      requestId?: string
      generation?: number
      candidateGeneration?: number
      fenceGeneration?: number
      revision?: number
      muted?: boolean
      pendingCount?: number
      queueDepth?: number
      queueWaitMs?: number
      bypassedQueue?: boolean
      restartCount?: number
      durationMs?: number
      reason?: string
      message?: string
      status?: string
    },
  ) {
    this.options.diagnostics?.({
      scope: 'native-media-controller',
      event,
      runtime: 'media',
      ...detail,
    })
  }
}

function unwrapResult(value: unknown) {
  if (value && typeof value === 'object' && 'session' in value) {
    return (value as { session: unknown }).session
  }
  return value
}

function isCancelledOperation(error: unknown) {
  return error instanceof Error && error.message.toLowerCase().endsWith('cancelled')
}

function isRecoverableRuntimeFailure(error: unknown) {
  return (
    error instanceof NativeRuntimeRequestError &&
    error.detail.retryable &&
    (error.detail.code === 'runtime_lost' ||
      error.detail.code === 'request_timeout' ||
      error.detail.code === 'handshake_failed')
  )
}

function isRuntimeGone(error: unknown) {
  return (
    error instanceof NativeRuntimeRequestError &&
    (error.detail.code === 'runtime_lost' ||
      error.detail.code === 'runtime_stopped' ||
      error.detail.code === 'runtime_degraded' ||
      error.detail.code === 'handshake_failed')
  )
}

function isHandshakeFailure(message: string) {
  return /\b(?:handshake|contract|runtime kind)\b/i.test(message)
}

function sameScreenLiveKitConnection(
  left: NativeMediaScreenSessionPrepareOptions,
  right: NativeMediaScreenSessionPrepareOptions,
) {
  return (
    left.livekit.url === right.livekit.url &&
    left.livekit.token === right.livekit.token &&
    left.livekit.participantIdentity === right.livekit.participantIdentity
  )
}

function assertSessionStartOptions(
  options: NativeMediaSessionStartOptions,
  selfWindowHwnd: string | undefined,
) {
  const command: MediaRuntimeCommand =
    options?.kind === 'microphone'
      ? {
          type: 'connectMicrophone',
          sessionId: 'validation',
          generation: 0,
          options,
          excludeProcessId: process.pid,
        }
      : {
          type: 'startScreenCapture',
          sessionId: 'validation',
          generation: 0,
          options: options as Extract<NativeMediaSessionStartOptions, { kind: 'screen' }>,
          selfWindowHwnd,
          excludeProcessId: process.pid,
        }
  if (!isNativeRuntimeCommand(command)) {
    throw new Error('Invalid native media session options')
  }
}

function readSessionResult(
  value: unknown,
  sessionId: string,
  options: NativeMediaSessionStartOptions,
): NativeMediaSession {
  const result = unwrapResult(value)
  if (!isNativeMediaSession(result)) {
    throw new Error('Native runtime returned no session metadata')
  }
  if (result.sessionId !== sessionId || result.kind !== options.kind) {
    throw new Error('Native runtime returned invalid session metadata')
  }
  return result
}

function readPreviewResult(value: unknown, sessionId: string) {
  const result = unwrapResult(value)
  if (
    !result ||
    typeof result !== 'object' ||
    (result as { sessionId?: unknown }).sessionId !== sessionId
  ) {
    throw new Error('Native runtime returned invalid preview metadata')
  }
  return { sessionId }
}

function isNativeMediaDeviceInfo(value: unknown): value is NativeMediaDeviceInfo {
  if (!value || typeof value !== 'object') return false
  const device = value as Partial<NativeMediaDeviceInfo>
  return (
    typeof device.deviceId === 'string' &&
    device.kind === 'audioinput' &&
    typeof device.label === 'string'
  )
}

function isDesktopDisplayMediaSource(
  value: unknown,
): value is DesktopDisplayMediaSource {
  if (!value || typeof value !== 'object') return false
  const source = value as Partial<DesktopDisplayMediaSource>
  return (
    typeof source.id === 'string' &&
    typeof source.name === 'string' &&
    (source.type === 'screen' || source.type === 'window' || source.type === 'game')
  )
}

function statusForSession(session: ActiveSession) {
  if (session.status === 'starting') return { status: 'starting' } as const
  if (session.status === 'error') {
    return { status: 'error', message: 'Native media session failed' } as const
  }
  const metadata = session.session
  return {
    status: 'running',
    sessionId: session.sessionId,
    width: metadata?.kind === 'screen' ? metadata.width : undefined,
    height: metadata?.kind === 'screen' ? metadata.height : undefined,
    fps: metadata?.kind === 'screen' ? metadata.fps : undefined,
    bitrate: metadata?.kind === 'screen' ? metadata.bitrate : undefined,
  } as const
}

function stateForSession(session: NativeMediaSession): NativeMediaStateEvent {
  return session.kind === 'microphone'
    ? {
        status: 'running',
        sessionId: session.sessionId,
        audio: session.audio,
      }
    : {
        status: 'running',
        sessionId: session.sessionId,
        width: session.width,
        height: session.height,
        fps: session.fps,
        bitrate: session.bitrate,
        audio: session.audio,
      }
}

function sessionSummary(session: ActiveSession): NativeMediaEngineSessionSummary {
  const common = {
    sessionId: session.sessionId,
    status: session.status,
    width: session.session?.kind === 'screen' ? session.session.width : undefined,
    height: session.session?.kind === 'screen' ? session.session.height : undefined,
    fps: session.session?.kind === 'screen' ? session.session.fps : undefined,
    bitrate: session.session?.kind === 'screen' ? session.session.bitrate : undefined,
  }
  if (session.options.kind === 'microphone') {
    return {
      ...common,
      kind: 'microphone',
      audio: session.session?.kind === 'microphone' ? session.session.audio : undefined,
    }
  }
  return {
    ...common,
    kind: 'screen',
    audio: session.session?.kind === 'screen' ? session.session.audio : undefined,
  }
}
