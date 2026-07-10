import type {
  LiveKitNativePublisherCredentials,
  LocalMediaIntent,
  LocalMediaIntentAcceptanceResult,
  LocalMediaIntentMicrophone,
  LocalMediaIntentScreen,
  LocalMediaObservedStateEvent,
  NativeMediaMicrophoneSessionStartOptions,
  NativeMediaScreenSessionPrepareOptions,
  NativeMediaScreenSessionStartOptions,
  NativeMediaSession,
  ScreenSourceSpec,
} from '@syrnike13/platform'

import {
  assertLocalMediaIntent,
} from '@syrnike13/platform'

import {
  NativeMediaController,
  type NativeMediaControllerEvent,
} from './native-media-controller'
import { NativeRuntimeRequestError } from './runtime-supervisor'

type MediaKind = 'microphone' | 'screen'

type NativeMediaReconcilerListener = (event: LocalMediaObservedStateEvent) => void

type ScheduledReconcile = Readonly<{
  cancel(): void
}>

type NativeMediaExecutionAdapter = {
  cancelPendingStarts(kind: MediaKind): Promise<void>
  startMicrophone(options: NativeMediaMicrophoneSessionStartOptions): Promise<NativeMediaSession>
  reconnectMicrophone(
    sessionId: string,
    options: NativeMediaMicrophoneSessionStartOptions,
  ): Promise<NativeMediaSession>
  setMicrophoneMuted(sessionId: string, muted: boolean): Promise<void>
  prepareScreen(options: NativeMediaScreenSessionPrepareOptions): Promise<void>
  startScreen(options: NativeMediaScreenSessionStartOptions): Promise<NativeMediaSession>
  disconnectPreparedScreen(): Promise<void>
  stopSession(sessionId?: string): Promise<void>
}

export type NativeMediaReconcilerOptions = Readonly<{
  execution: NativeMediaExecutionAdapter
  schedule?: (callback: () => void, delayMs: number) => ScheduledReconcile
}>

const RETRY_DELAYS_MS = [250, 1_000, 5_000] as const

export class NativeMediaIntentError extends Error {
  readonly code: 'stale_intent'

  constructor(message: string) {
    super(message)
    this.name = 'NativeMediaIntentError'
    this.code = 'stale_intent'
  }
}

type AcceptedKindState<TIntent> = Readonly<{
  operationId: string | null
  envelopeRevision: number
  revision: number
  intent: TIntent
}>

type MicrophoneRuntimeState = {
  sessionId: string | null
  participantIdentity: string | null
  muted: boolean
  audioBitrateKbps: number | null
  state: 'off' | 'retained' | 'publishing' | 'published' | 'stopping'
}

type ScreenRuntimeState = {
  sessionId: string | null
  participantIdentity: string | null
  source: ScreenSourceSpec | null
  state: 'off' | 'preparing' | 'prepared' | 'publishing' | 'published' | 'stopping'
}

type KindLoopState = {
  running: boolean
  dirty: boolean
}

type AttemptToken = Readonly<{
  operationId: string | null
  envelopeRevision: number
  revision: number
  reconcileAttempt: number
}>

type MicrophonePublishIntent = Extract<
  LocalMediaIntentMicrophone,
  Readonly<{ state: 'publish' }>
>

type ScreenActiveIntent = Readonly<{
  revision: number
  state: 'prepare' | 'publish'
  credentials: LiveKitNativePublisherCredentials
  source: ScreenSourceSpec
}>

type ScreenPublishIntent = Readonly<{
  revision: number
  state: 'publish'
  credentials: LiveKitNativePublisherCredentials
  source: ScreenSourceSpec
}>

export class NativeMediaReconciler {
  private readonly listeners = new Set<NativeMediaReconcilerListener>()
  private readonly loops: Record<MediaKind, KindLoopState> = {
    microphone: { running: false, dirty: false },
    screen: { running: false, dirty: false },
  }
  private acceptedIntent: LocalMediaIntent | null = null
  private acceptedMicrophone: AcceptedKindState<LocalMediaIntentMicrophone> | null = null
  private acceptedScreen: AcceptedKindState<LocalMediaIntentScreen> | null = null
  private sequence = 0
  private nextReconcileAttempt: Record<MediaKind, number> = {
    microphone: 0,
    screen: 0,
  }
  private microphoneCurrent: MicrophoneRuntimeState = {
    sessionId: null,
    participantIdentity: null,
    muted: false,
    audioBitrateKbps: null,
    state: 'off',
  }
  private screenCurrent: ScreenRuntimeState = {
    sessionId: null,
    participantIdentity: null,
    source: null,
    state: 'off',
  }
  private microphoneAttempt: AttemptToken | null = null
  private screenAttempt: AttemptToken | null = null
  private readonly retryAttempts: Record<MediaKind, number> = {
    microphone: 0,
    screen: 0,
  }
  private readonly scheduledRetries: Partial<Record<MediaKind, ScheduledReconcile>> = {}
  private lastRuntimeRestartCount = 0
  private lastRuntimeLossKey = ''
  private runtimeCanRetry = true
  private disposed = false

  constructor(private readonly options: NativeMediaReconcilerOptions) {}

  subscribe(listener: NativeMediaReconcilerListener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async applyIntent(
    intent: LocalMediaIntent,
  ): Promise<LocalMediaIntentAcceptanceResult> {
    if (this.disposed) {
      throw new Error('Native media reconciler is disposed')
    }
    assertLocalMediaIntent(intent)
    const frozen = freezeIntent(intent)
    const duplicateDisposition = this.validateAcceptedIntent(frozen)
    if (duplicateDisposition === 'duplicate') {
      return {
        operationId: frozen.operationId,
        acceptedEnvelopeRevision: frozen.envelopeRevision,
        disposition: 'duplicate',
      }
    }

    const previous = this.acceptedIntent
    const envelopeOwnerChanged =
      !previous || previous.operationId !== frozen.operationId
    const microphoneChanged =
      envelopeOwnerChanged ||
      !previous ||
      !deepEqual(previous.microphone, frozen.microphone)
    const screenChanged =
      envelopeOwnerChanged ||
      !previous ||
      !deepEqual(previous.screen, frozen.screen)
    const microphoneWasReconciling = this.loops.microphone.running
    const screenWasReconciling = this.loops.screen.running

    if (microphoneChanged) this.cancelScheduledRetry('microphone', true)
    if (screenChanged) this.cancelScheduledRetry('screen', true)

    this.acceptedIntent = frozen
    if (microphoneChanged) {
      this.acceptedMicrophone = {
        operationId: frozen.operationId,
        envelopeRevision: frozen.envelopeRevision,
        revision: frozen.microphone.revision,
        intent: frozen.microphone,
      }
    }
    if (screenChanged) {
      this.acceptedScreen = {
        operationId: frozen.operationId,
        envelopeRevision: frozen.envelopeRevision,
        revision: frozen.screen.revision,
        intent: frozen.screen,
      }
    }

    // Reconciliation completion is deliberately asynchronous, but recency
    // fencing cannot wait behind the operation it supersedes. The controller
    // advances the native execution fence immediately, so a late LiveKit
    // publish acknowledgement cannot promote an obsolete candidate.
    if (microphoneChanged && microphoneWasReconciling) {
      void this.options.execution.cancelPendingStarts('microphone').catch(() => {
        // The active reconcile loop owns error projection. This call exists
        // only to publish the newer execution fence as early as possible.
      })
    }
    if (screenChanged && screenWasReconciling) {
      void this.options.execution.cancelPendingStarts('screen').catch(() => {
        // See microphone supersession above.
      })
    }

    if (microphoneChanged) this.markDirty('microphone')
    if (screenChanged) this.markDirty('screen')

    return {
      operationId: frozen.operationId,
      acceptedEnvelopeRevision: frozen.envelopeRevision,
      disposition: 'accepted',
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.cancelScheduledRetry('microphone', true)
    this.cancelScheduledRetry('screen', true)
    this.listeners.clear()
  }

  recoverAfterRuntimeRestart(restartCount: number) {
    if (
      this.disposed ||
      restartCount <= this.lastRuntimeRestartCount
    ) {
      return
    }
    this.lastRuntimeRestartCount = restartCount
    this.runtimeCanRetry = true
    this.cancelScheduledRetry('microphone', true)
    this.cancelScheduledRetry('screen', true)
    this.microphoneAttempt = null
    this.screenAttempt = null
    this.microphoneCurrent = {
      sessionId: null,
      participantIdentity: null,
      muted: false,
      audioBitrateKbps: null,
      state: 'off',
    }
    this.screenCurrent = {
      sessionId: null,
      participantIdentity: null,
      source: null,
      state: 'off',
    }
    if (this.acceptedMicrophone) this.markDirty('microphone')
    if (this.acceptedScreen) this.markDirty('screen')
  }

  observeRuntimeUnavailable(
    restartCount: number,
    status: 'recovering' | 'degraded',
  ) {
    if (this.disposed) return
    const lossKey = `${restartCount}:${status}`
    if (this.lastRuntimeLossKey === lossKey) return
    this.lastRuntimeLossKey = lossKey
    this.runtimeCanRetry = false
    this.cancelScheduledRetry('microphone', true)
    this.cancelScheduledRetry('screen', true)
    this.microphoneAttempt = null
    this.screenAttempt = null
    this.microphoneCurrent = {
      sessionId: null,
      participantIdentity: null,
      muted: false,
      audioBitrateKbps: null,
      state: 'off',
    }
    this.screenCurrent = {
      sessionId: null,
      participantIdentity: null,
      source: null,
      state: 'off',
    }
    const microphoneIntent = this.acceptedIntentFor('microphone')
    const screenIntent = this.acceptedIntentFor('screen')
    const retryable = status === 'recovering'
    if (microphoneIntent && microphoneIntent.microphone.state !== 'off') {
      this.emitMicrophoneTerminal(microphoneIntent, {
        code: status === 'degraded' ? 'runtime_degraded' : 'runtime_lost',
        stage: 'runtime',
        retryable,
      })
    }
    if (screenIntent && screenIntent.screen.state !== 'off') {
      this.emitScreenTerminal(screenIntent, {
        code: status === 'degraded' ? 'runtime_degraded' : 'runtime_lost',
        stage: 'runtime',
        retryable,
      })
    }
  }

  observeExecutionEvent(event: NativeMediaControllerEvent) {
    if (this.disposed || event.type !== 'executionTerminal') return
    const terminal = event.event
    const intent = this.acceptedIntentFor(terminal.kind)
    if (!intent) return
    if (
      terminal.kind === 'microphone' &&
      this.microphoneCurrent.sessionId === terminal.sessionId
    ) {
      this.microphoneCurrent = {
        sessionId: null,
        participantIdentity: null,
        muted: this.microphoneCurrent.muted,
        audioBitrateKbps: this.microphoneCurrent.audioBitrateKbps,
        state: 'off',
      }
      if (intent.microphone.state === 'off') return
      this.emitMicrophoneTerminal(intent, terminal)
      this.scheduleRetry(
        'microphone',
        intent,
        terminalError(terminal),
      )
      return
    }
    if (
      terminal.kind === 'screen' &&
      this.screenCurrent.sessionId === terminal.sessionId
    ) {
      this.screenCurrent = {
        sessionId: null,
        participantIdentity: null,
        source: null,
        state: 'off',
      }
      if (intent.screen.state === 'off') return
      this.emitScreenTerminal(intent, terminal)
      this.scheduleRetry('screen', intent, terminalError(terminal))
    }
  }

  private validateAcceptedIntent(
    nextIntent: LocalMediaIntent,
  ): 'accepted' | 'duplicate' {
    const current = this.acceptedIntent
    if (!current) {
      return 'accepted'
    }
    if (deepEqual(current, nextIntent)) {
      return 'duplicate'
    }
    if (nextIntent.envelopeRevision <= current.envelopeRevision) {
      throw new NativeMediaIntentError(
        'Local media intent envelope revision is stale',
      )
    }
    assertKindMonotonicity(
      current.microphone,
      nextIntent.microphone,
      'microphone',
    )
    assertKindMonotonicity(current.screen, nextIntent.screen, 'screen')
    return 'accepted'
  }

  private markDirty(kind: MediaKind) {
    const loop = this.loops[kind]
    loop.dirty = true
    if (loop.running) {
      return
    }
    loop.running = true
    void this.runLoop(kind)
  }

  private async runLoop(kind: MediaKind) {
    const loop = this.loops[kind]
    try {
      while (loop.dirty && !this.disposed) {
        loop.dirty = false
        const accepted = this.acceptedIntentFor(kind)
        if (!accepted) {
          continue
        }
        try {
          if (kind === 'microphone') {
            await this.reconcileMicrophone(accepted)
          } else {
            await this.reconcileScreen(accepted)
          }
        } catch (error) {
          this.emitUnhandledReconcileError(kind, accepted, error)
          this.scheduleRetry(kind, accepted, error)
        }
      }
    } finally {
      loop.running = false
      if (loop.dirty && !this.disposed) {
        this.markDirty(kind)
      }
    }
  }

  private async reconcileMicrophone(intent: LocalMediaIntent) {
    const desired = intent.microphone
    const activeRevision = desired.revision
    const attempt = this.beginAttempt('microphone', intent, activeRevision)

    if (desired.state === 'off') {
      if (this.microphoneCurrent.sessionId) {
        this.microphoneCurrent.state = 'stopping'
        this.emitMicrophone(intent.operationId, activeRevision, attempt.reconcileAttempt, 'stopping', {
          muted: this.microphoneCurrent.muted,
          audioBitrateKbps: this.microphoneCurrent.audioBitrateKbps,
          participantIdentity: this.microphoneCurrent.participantIdentity,
        })
        await this.options.execution.stopSession(this.microphoneCurrent.sessionId)
      } else {
        await this.options.execution.cancelPendingStarts('microphone')
      }
      if (!this.isCurrentAttempt('microphone', attempt)) {
        return
      }
      this.microphoneCurrent = {
        sessionId: null,
        participantIdentity: null,
        muted: false,
        audioBitrateKbps: null,
        state: 'off',
      }
      this.emitMicrophone(intent.operationId, activeRevision, attempt.reconcileAttempt, 'off', {
        muted: false,
        audioBitrateKbps: null,
        participantIdentity: null,
      })
      this.cancelScheduledRetry('microphone', true)
      return
    }

    if (desired.state === 'retain') {
      if (this.microphoneCurrent.sessionId) {
        await this.options.execution.setMicrophoneMuted(
          this.microphoneCurrent.sessionId,
          desired.muted,
        )
      } else {
        await this.options.execution.cancelPendingStarts('microphone')
        this.microphoneCurrent = {
          sessionId: null,
          participantIdentity: null,
          muted: desired.muted,
          audioBitrateKbps: null,
          state: 'off',
        }
        if (!this.isCurrentAttempt('microphone', attempt)) return
        this.emitMicrophone(intent.operationId, activeRevision, attempt.reconcileAttempt, 'off', {
          muted: desired.muted,
          audioBitrateKbps: null,
          participantIdentity: null,
        })
        this.cancelScheduledRetry('microphone', true)
        return
      }
      if (!this.isCurrentAttempt('microphone', attempt)) return
      this.microphoneCurrent = {
        ...this.microphoneCurrent,
        muted: desired.muted,
        state: 'retained',
      }
      this.emitMicrophone(intent.operationId, activeRevision, attempt.reconcileAttempt, 'retained', {
        muted: desired.muted,
        audioBitrateKbps: this.microphoneCurrent.audioBitrateKbps,
        participantIdentity: this.microphoneCurrent.participantIdentity,
      })
      this.cancelScheduledRetry('microphone', true)
      return
    }

    this.microphoneCurrent = {
      ...this.microphoneCurrent,
      muted: desired.muted,
      audioBitrateKbps: desired.audioBitrateKbps,
      participantIdentity: desired.credentials.participantIdentity,
      state: 'publishing',
    }
    this.emitMicrophone(intent.operationId, activeRevision, attempt.reconcileAttempt, 'publishing', {
      muted: desired.muted,
      audioBitrateKbps: desired.audioBitrateKbps,
      participantIdentity: desired.credentials.participantIdentity,
    })

    try {
      const session =
        this.microphoneCurrent.sessionId === null
          ? await this.options.execution.startMicrophone(
              microphoneStartOptions(intent.operationId, desired),
            )
          : await this.options.execution.reconnectMicrophone(
              this.microphoneCurrent.sessionId,
              microphoneStartOptions(intent.operationId, desired),
            )

      if (!this.isCurrentAttempt('microphone', attempt)) {
        // A successful reconnect is already committed inside the native actor.
        // Preserve that execution truth even when a newer user intent arrived
        // while the request was in flight; the serialized loop will reconcile
        // the newest intent from this real publication instead of a stale one.
        this.microphoneCurrent = {
          sessionId: session.sessionId,
          participantIdentity: readParticipantIdentity(
            session,
            desired.credentials,
          ),
          muted: desired.muted,
          audioBitrateKbps: desired.audioBitrateKbps,
          state: 'published',
        }
        return
      }

      this.microphoneCurrent = {
        sessionId: session.sessionId,
        participantIdentity: readParticipantIdentity(
          session,
          desired.credentials,
        ),
        muted: desired.muted,
        audioBitrateKbps: desired.audioBitrateKbps,
        state: 'published',
      }
      this.emitMicrophone(intent.operationId, activeRevision, attempt.reconcileAttempt, 'published', {
        muted: desired.muted,
        audioBitrateKbps: desired.audioBitrateKbps,
        participantIdentity: this.microphoneCurrent.participantIdentity,
      })
      this.cancelScheduledRetry('microphone', true)
    } catch (error) {
      if (!this.isCurrentAttempt('microphone', attempt)) {
        return
      }
      this.microphoneCurrent = {
        ...this.microphoneCurrent,
        state: 'off',
      }
      this.emitMicrophoneError(
        intent.operationId,
        activeRevision,
        attempt.reconcileAttempt,
        desired,
        error,
      )
      this.scheduleRetry('microphone', intent, error)
    }
  }

  private async reconcileScreen(intent: LocalMediaIntent) {
    const desired = intent.screen
    const activeRevision = desired.revision
    const attempt = this.beginAttempt('screen', intent, activeRevision)

    if (desired.state === 'off') {
      if (this.screenCurrent.sessionId) {
        this.screenCurrent.state = 'stopping'
        this.emitScreen(intent.operationId, activeRevision, attempt.reconcileAttempt, 'stopping', {
          source: this.screenCurrent.source,
          participantIdentity: this.screenCurrent.participantIdentity,
        })
        await this.options.execution.stopSession(this.screenCurrent.sessionId)
      }
      await this.options.execution.disconnectPreparedScreen()
      if (!this.isCurrentAttempt('screen', attempt)) {
        return
      }
      this.screenCurrent = {
        sessionId: null,
        participantIdentity: null,
        source: null,
        state: 'off',
      }
      this.emitScreen(intent.operationId, activeRevision, attempt.reconcileAttempt, 'off', {
        source: null,
        participantIdentity: null,
      })
      this.cancelScheduledRetry('screen', true)
      return
    }

    if (desired.state === 'prepare') {
      this.screenCurrent = {
        sessionId: this.screenCurrent.sessionId,
        participantIdentity: desired.credentials.participantIdentity,
        source: desired.source,
        state: 'preparing',
      }
      this.emitScreen(intent.operationId, activeRevision, attempt.reconcileAttempt, 'preparing', {
        source: desired.source,
        participantIdentity: desired.credentials.participantIdentity,
      })
      try {
        await this.options.execution.prepareScreen(
          screenPrepareOptions(desired.credentials),
        )
        if (!this.isCurrentAttempt('screen', attempt)) {
          return
        }
        this.screenCurrent = {
          sessionId: this.screenCurrent.sessionId,
          participantIdentity: desired.credentials.participantIdentity,
          source: desired.source,
          state: 'prepared',
        }
        this.emitScreen(intent.operationId, activeRevision, attempt.reconcileAttempt, 'prepared', {
          source: desired.source,
          participantIdentity: desired.credentials.participantIdentity,
        })
        this.cancelScheduledRetry('screen', true)
      } catch (error) {
        if (!this.isCurrentAttempt('screen', attempt)) {
          return
        }
        this.screenCurrent = {
          sessionId: null,
          participantIdentity: desired.credentials.participantIdentity,
          source: desired.source,
          state: 'off',
        }
        this.emitScreenError(
          intent.operationId,
          activeRevision,
          attempt.reconcileAttempt,
          desired,
          error,
        )
        this.scheduleRetry('screen', intent, error)
      }
      return
    }

    const publishDesired = desired as ScreenPublishIntent
    this.screenCurrent = {
      sessionId: this.screenCurrent.sessionId,
      participantIdentity: publishDesired.credentials.participantIdentity,
      source: publishDesired.source,
      state: 'publishing',
    }
    this.emitScreen(intent.operationId, activeRevision, attempt.reconcileAttempt, 'publishing', {
      source: publishDesired.source,
      participantIdentity: publishDesired.credentials.participantIdentity,
    })
    try {
      const session = await this.options.execution.startScreen(
        screenStartOptions(intent.operationId, publishDesired),
      )
      if (!this.isCurrentAttempt('screen', attempt)) {
        await this.bestEffortRetireSession(session)
        return
      }
      this.screenCurrent = {
        sessionId: session.sessionId,
        participantIdentity: readParticipantIdentity(
          session,
          publishDesired.credentials,
        ),
        source: publishDesired.source,
        state: 'published',
      }
      this.emitScreen(intent.operationId, activeRevision, attempt.reconcileAttempt, 'published', {
        source: publishDesired.source,
        participantIdentity: this.screenCurrent.participantIdentity,
      })
      this.cancelScheduledRetry('screen', true)
    } catch (error) {
      if (!this.isCurrentAttempt('screen', attempt)) {
        return
      }
      this.screenCurrent = {
        sessionId: null,
        participantIdentity: publishDesired.credentials.participantIdentity,
        source: publishDesired.source,
        state: 'off',
      }
      this.emitScreenError(
        intent.operationId,
        activeRevision,
        attempt.reconcileAttempt,
        publishDesired,
        error,
      )
      this.scheduleRetry('screen', intent, error)
    }
  }

  private emitMicrophone(
    operationId: string | null,
    revision: number,
    reconcileAttempt: number,
    state: Exclude<
      Extract<LocalMediaObservedStateEvent, { kind: 'microphone' }>['state'],
      'error'
    >,
    detail: Readonly<{
      muted: boolean
      audioBitrateKbps: number | null
      participantIdentity: string | null
    }>,
  ) {
    this.emit({
      kind: 'microphone',
      operationId,
      revision,
      reconcileAttempt,
      sequence: ++this.sequence,
      state,
      muted: detail.muted,
      audioBitrateKbps: detail.audioBitrateKbps,
      participantIdentity: detail.participantIdentity,
    })
  }

  private emitMicrophoneError(
    operationId: string | null,
    revision: number,
    reconcileAttempt: number,
    desired: MicrophonePublishIntent,
    error: unknown,
  ) {
    const detail = executionError(error, 'publish')
    this.emit({
      kind: 'microphone',
      operationId,
      revision,
      reconcileAttempt,
      sequence: ++this.sequence,
      state: 'error',
      muted: desired.muted,
      audioBitrateKbps: desired.audioBitrateKbps,
      participantIdentity: desired.credentials.participantIdentity,
      errorCode: detail.code,
      errorMessage: errorMessage(),
      errorStage: detail.stage,
      retryable: detail.retryable,
    })
  }

  private emitScreen(
    operationId: string | null,
    revision: number,
    reconcileAttempt: number,
    state: Exclude<
      Extract<LocalMediaObservedStateEvent, { kind: 'screen' }>['state'],
      'error'
    >,
    detail: Readonly<{
      source: ScreenSourceSpec | null
      participantIdentity: string | null
    }>,
  ) {
    this.emit({
      kind: 'screen',
      operationId,
      revision,
      reconcileAttempt,
      sequence: ++this.sequence,
      state,
      source: detail.source,
      participantIdentity: detail.participantIdentity,
    })
  }

  private emitScreenError(
    operationId: string | null,
    revision: number,
    reconcileAttempt: number,
    desired: ScreenActiveIntent,
    error: unknown,
  ) {
    const detail = executionError(error, desired.state)
    this.emit({
      kind: 'screen',
      operationId,
      revision,
      reconcileAttempt,
      sequence: ++this.sequence,
      state: 'error',
      source: desired.source,
      participantIdentity: desired.credentials.participantIdentity,
      errorCode: detail.code,
      errorMessage: errorMessage(),
      errorStage: detail.stage,
      retryable: detail.retryable,
    })
  }

  private emit(event: LocalMediaObservedStateEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // One observer must not interrupt reconciliation or starve later observers.
      }
    }
  }

  private emitUnhandledReconcileError(
    kind: MediaKind,
    intent: LocalMediaIntent,
    error: unknown,
  ) {
    const detail = executionError(
      error,
      kind === 'microphone' ? intent.microphone.state : intent.screen.state,
    )
    if (kind === 'microphone') {
      const desired = intent.microphone
      if (!this.isAcceptedIntent('microphone', intent, desired.revision)) return
      this.emit({
        kind,
        operationId: intent.operationId,
        revision: desired.revision,
        reconcileAttempt: this.currentReconcileAttempt(kind),
        sequence: ++this.sequence,
        state: 'error',
        muted: desired.state === 'off' ? false : desired.muted,
        audioBitrateKbps:
          desired.state === 'publish'
            ? desired.audioBitrateKbps
            : this.microphoneCurrent.audioBitrateKbps,
        participantIdentity:
          desired.state === 'publish'
            ? desired.credentials.participantIdentity
            : this.microphoneCurrent.participantIdentity,
        errorCode: detail.code,
        errorMessage: errorMessage(),
        errorStage: detail.stage,
        retryable: detail.retryable,
      })
      return
    }

    const desired = intent.screen
    if (!this.isAcceptedIntent('screen', intent, desired.revision)) return
    this.emit({
      kind,
      operationId: intent.operationId,
      revision: desired.revision,
      reconcileAttempt: this.currentReconcileAttempt(kind),
      sequence: ++this.sequence,
      state: 'error',
      source: desired.state === 'off' ? this.screenCurrent.source : desired.source,
      participantIdentity:
        desired.state === 'off'
          ? this.screenCurrent.participantIdentity
          : desired.credentials.participantIdentity,
      errorCode: detail.code,
      errorMessage: errorMessage(),
      errorStage: detail.stage,
      retryable: detail.retryable,
    })
  }

  private emitMicrophoneTerminal(
    intent: LocalMediaIntent,
    error: Readonly<{ code: string; stage: string; retryable: boolean }>,
  ) {
    const desired = intent.microphone
    this.emit({
      kind: 'microphone',
      operationId: intent.operationId,
      revision: desired.revision,
      reconcileAttempt: this.currentReconcileAttempt('microphone'),
      sequence: ++this.sequence,
      state: 'error',
      muted: desired.state === 'off' ? false : desired.muted,
      audioBitrateKbps:
        desired.state === 'publish' ? desired.audioBitrateKbps : null,
      participantIdentity:
        desired.state === 'publish'
          ? desired.credentials.participantIdentity
          : null,
      errorCode: error.code,
      errorMessage: errorMessage(),
      errorStage: error.stage,
      retryable: error.retryable,
    })
  }

  private emitScreenTerminal(
    intent: LocalMediaIntent,
    error: Readonly<{ code: string; stage: string; retryable: boolean }>,
  ) {
    const desired = intent.screen
    this.emit({
      kind: 'screen',
      operationId: intent.operationId,
      revision: desired.revision,
      reconcileAttempt: this.currentReconcileAttempt('screen'),
      sequence: ++this.sequence,
      state: 'error',
      source: desired.state === 'off' ? null : desired.source,
      participantIdentity:
        desired.state === 'off'
          ? null
          : desired.credentials.participantIdentity,
      errorCode: error.code,
      errorMessage: errorMessage(),
      errorStage: error.stage,
      retryable: error.retryable,
    })
  }

  private scheduleRetry(
    kind: MediaKind,
    intent: LocalMediaIntent,
    error: unknown,
  ) {
    const desired = kind === 'microphone' ? intent.microphone : intent.screen
    const current = kind === 'microphone'
      ? this.acceptedMicrophone
      : this.acceptedScreen
    if (
      this.disposed ||
      !this.runtimeCanRetry ||
      !current ||
      current.operationId !== intent.operationId ||
      current.envelopeRevision !== intent.envelopeRevision ||
      current.revision !== desired.revision ||
      !executionError(error, desired.state).retryable
    ) {
      return
    }

    this.cancelScheduledRetry(kind, false)
    const attempt = this.retryAttempts[kind]
    const delayMs = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]
    this.retryAttempts[kind] = attempt + 1
    const schedule = this.options.schedule ?? defaultSchedule
    this.scheduledRetries[kind] = schedule(() => {
      delete this.scheduledRetries[kind]
      const latest = kind === 'microphone'
        ? this.acceptedMicrophone
        : this.acceptedScreen
      if (
        this.disposed ||
        !latest ||
        latest.operationId !== intent.operationId ||
        latest.envelopeRevision !== intent.envelopeRevision ||
        latest.revision !== desired.revision
      ) {
        return
      }
      this.markDirty(kind)
    }, delayMs)
  }

  private cancelScheduledRetry(kind: MediaKind, resetAttempts: boolean) {
    this.scheduledRetries[kind]?.cancel()
    delete this.scheduledRetries[kind]
    if (resetAttempts) this.retryAttempts[kind] = 0
  }

  private beginAttempt(
    kind: MediaKind,
    intent: LocalMediaIntent,
    revision: number,
  ): AttemptToken {
    this.nextReconcileAttempt[kind] += 1
    const token: AttemptToken = {
      operationId: intent.operationId,
      envelopeRevision: intent.envelopeRevision,
      revision,
      reconcileAttempt: this.nextReconcileAttempt[kind],
    }
    if (kind === 'microphone') this.microphoneAttempt = token
    else this.screenAttempt = token
    return token
  }

  private currentReconcileAttempt(kind: MediaKind) {
    return this.nextReconcileAttempt[kind]
  }

  private isCurrentAttempt(
    kind: MediaKind,
    attempt: AttemptToken,
  ) {
    const accepted = kind === 'microphone'
      ? this.acceptedMicrophone
      : this.acceptedScreen
    if (
      !accepted ||
      accepted.operationId !== attempt.operationId ||
      accepted.envelopeRevision !== attempt.envelopeRevision ||
      accepted.revision !== attempt.revision
    ) {
      return false
    }
    const token = kind === 'microphone' ? this.microphoneAttempt : this.screenAttempt
    return token === attempt
  }

  private isAcceptedIntent(
    kind: MediaKind,
    intent: LocalMediaIntent,
    revision: number,
  ) {
    const accepted = kind === 'microphone'
      ? this.acceptedMicrophone
      : this.acceptedScreen
    return Boolean(
      accepted &&
      accepted.operationId === intent.operationId &&
      accepted.envelopeRevision === intent.envelopeRevision &&
      accepted.revision === revision,
    )
  }

  private acceptedIntentFor(kind: MediaKind): LocalMediaIntent | null {
    const envelope = this.acceptedIntent
    const accepted = kind === 'microphone'
      ? this.acceptedMicrophone
      : this.acceptedScreen
    if (!envelope || !accepted) return null
    return kind === 'microphone'
      ? {
          ...envelope,
          operationId: accepted.operationId,
          envelopeRevision: accepted.envelopeRevision,
          microphone: accepted.intent as LocalMediaIntentMicrophone,
        }
      : {
          ...envelope,
          operationId: accepted.operationId,
          envelopeRevision: accepted.envelopeRevision,
          screen: accepted.intent as LocalMediaIntentScreen,
        }
  }

  private async bestEffortRetireSession(session: NativeMediaSession) {
    try {
      await this.options.execution.stopSession(session.sessionId)
    } catch {
      // Phase 5: the controller/native runtime can still block this retire path.
    }
  }
}

export function createNativeMediaControllerExecutionAdapter(
  controller: NativeMediaController,
): NativeMediaExecutionAdapter {
  return {
    cancelPendingStarts: (kind) => controller.cancelPendingStarts(kind),
    startMicrophone: (options) => controller.startSession(options),
    reconnectMicrophone: (sessionId, options) =>
      controller.reconnectMicrophoneSession(sessionId, options),
    setMicrophoneMuted: (sessionId, muted) =>
      controller.setMicrophoneMuted(sessionId, muted),
    prepareScreen: (options) => controller.prepareScreenSession(options),
    startScreen: (options) => controller.startSession(options),
    disconnectPreparedScreen: () => controller.disconnectPreparedScreenSession(),
    stopSession: (sessionId) => controller.stopSession(sessionId),
  }
}

function freezeIntent(intent: LocalMediaIntent): LocalMediaIntent {
  return deepFreeze(structuredClone(intent))
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child)
    }
    Object.freeze(value)
  }
  return value
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function assertKindMonotonicity<TIntent extends { revision: number }>(
  current: TIntent,
  next: TIntent,
  label: string,
) {
  if (next.revision < current.revision) {
    throw new NativeMediaIntentError(`${label} revision is stale`)
  }
  if (next.revision === current.revision && !deepEqual(current, next)) {
    throw new NativeMediaIntentError(`${label} revision conflicts with accepted intent`)
  }
}

function microphoneStartOptions(
  operationId: string | null,
  desired: MicrophonePublishIntent,
): NativeMediaMicrophoneSessionStartOptions {
  return {
    kind: 'microphone',
    requestId: `${operationId ?? 'local-media'}:microphone:${desired.revision}`,
    audioBitrate: desired.audioBitrateKbps * 1_000,
    muted: desired.muted,
    livekit: desired.credentials,
  }
}

function screenPrepareOptions(
  credentials: LiveKitNativePublisherCredentials,
): NativeMediaScreenSessionPrepareOptions {
  return { livekit: credentials }
}

function screenStartOptions(
  operationId: string | null,
  desired: ScreenPublishIntent,
): NativeMediaScreenSessionStartOptions {
  return {
    kind: 'screen',
    requestId: `${operationId ?? 'local-media'}:screen:${desired.revision}`,
    sourceId: desired.source.sourceId,
    width: desired.source.width,
    height: desired.source.height,
    fps: desired.source.fps,
    bitrate: desired.source.bitrate,
    audioBitrate: desired.source.audioBitrate,
    audio: {
      requested: desired.source.audioRequested,
    },
    livekit: desired.credentials,
  }
}

function readParticipantIdentity(
  session: NativeMediaSession,
  credentials: LiveKitNativePublisherCredentials,
) {
  return 'nativeParticipantIdentity' in session &&
    typeof session.nativeParticipantIdentity === 'string'
    ? session.nativeParticipantIdentity
    : credentials.participantIdentity
}

function errorMessage() {
  return 'Native media execution failed'
}

function executionError(error: unknown, fallbackStage: string) {
  if (error instanceof NativeRuntimeRequestError) {
    return {
      code: error.detail.code,
      stage: error.detail.stage ?? fallbackStage,
      retryable: error.detail.retryable,
    }
  }
  return {
    code: 'execution_failed',
    stage: fallbackStage,
    retryable: true,
  }
}

function terminalError(
  terminal: Readonly<{ code: string; stage: string; retryable: boolean }>,
) {
  return new NativeRuntimeRequestError({
    code: terminal.code,
    message: 'Native media execution terminated',
    stage: terminal.stage,
    retryable: terminal.retryable,
  })
}

function defaultSchedule(callback: () => void, delayMs: number): ScheduledReconcile {
  const timer = setTimeout(callback, delayMs)
  return {
    cancel: () => clearTimeout(timer),
  }
}
