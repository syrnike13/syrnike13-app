import type {
  LocalMediaIntent,
  LocalMediaObservedStateEvent,
  ScreenSourceSpec,
  SyrnikeDesktopApi,
} from '@syrnike13/platform'

import type { LiveKitNativeCredentialLease } from '#/features/voice/voice-join'

type VoiceNativeMediaContext = Readonly<{
  operationId: string | null
  channelId: string | null
}>

type VoiceNativeMicrophoneDesired = Readonly<{
  enabled: boolean
  muted: boolean
  audioBitrateKbps: number
  revision: number
}>

type VoiceNativeScreenDesired =
  | Readonly<{
      state: 'off'
      revision: number
      source: null
    }>
  | Readonly<{
      state: 'prepare' | 'publish'
      revision: number
      source: ScreenSourceSpec
    }>

type VoiceNativeMicrophoneObserved = Readonly<{
  operationId: string | null
  revision: number
  sequence: number
  state: 'off' | 'retained' | 'publishing' | 'published' | 'stopping' | 'error'
  muted: boolean
  participantIdentity: string | null
}>

type VoiceNativeScreenObserved = Readonly<{
  operationId: string | null
  revision: number
  sequence: number
  state:
    | 'off'
    | 'preparing'
    | 'prepared'
    | 'publishing'
    | 'published'
    | 'stopping'
    | 'error'
  participantIdentity: string | null
}>

type VoiceNativeScreenObservedEvent = Extract<
  LocalMediaObservedStateEvent,
  { kind: 'screen' }
>

type VoiceNativeMediaWaiter = {
  kind: LocalMediaObservedStateEvent['kind']
  operationId: string | null
  revision: number
  states: ReadonlySet<string>
  resolve: (event: LocalMediaObservedStateEvent) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type VoiceNativeMediaApplication = {
  intent: LocalMediaIntent
  promise: Promise<void>
}

export type VoiceNativeMediaCallbacks = Readonly<{
  onMicrophoneState?: (event: LocalMediaObservedStateEvent) => void
  onScreenState?: (event: LocalMediaObservedStateEvent) => void
  onIntentError?: (error: Error, intent: LocalMediaIntent) => void
}>

export type VoiceNativeMediaOwner = {
  bindDesktop(
    getDesktop: () => SyrnikeDesktopApi | null | undefined,
    callbacks?: VoiceNativeMediaCallbacks,
  ): () => void
  setVoiceContext(context: VoiceNativeMediaContext): void
  setLiveKitCredentials(lease: LiveKitNativeCredentialLease): void
  syncMicrophone(input: {
    enabled: boolean
    muted: boolean
    audioBitrateKbps: number
  }): Promise<number | null>
  waitForMicrophonePublished(
    revision: number,
    timeoutMs?: number,
  ): Promise<Extract<LocalMediaObservedStateEvent, { kind: 'microphone' }>>
  setDesiredMicrophoneMuted(muted: boolean): Promise<void>
  prepareScreenShare(source: ScreenSourceSpec): Promise<number>
  publishScreenShare(source: ScreenSourceSpec): Promise<number>
  stopScreenShare(): Promise<number>
  waitForScreenState(
    revision: number,
    states: ReadonlyArray<
      Extract<
        LocalMediaObservedStateEvent,
        { kind: 'screen' }
      >['state']
    >,
    timeoutMs?: number,
  ): Promise<Extract<LocalMediaObservedStateEvent, { kind: 'screen' }>>
  reset(): void
  hasActiveMicrophone(channelId: string | null): boolean
  hasMicrophonePublishing(channelId: string | null): boolean
  isMicrophoneMuted(): boolean
  hasObservedMicrophone(): boolean
  getScreenParticipantIdentity(): string | null
}

const SCREEN_WAIT_TIMEOUT_MS = 10_000
const MICROPHONE_WAIT_TIMEOUT_MS = 20_000

function samePublisherCredentials(
  left: { url: string; token: string; participantIdentity: string },
  right: { url: string; token: string; participantIdentity: string },
) {
  return (
    left.url === right.url &&
    left.token === right.token &&
    left.participantIdentity === right.participantIdentity
  )
}

function sameSource(
  left: ScreenSourceSpec | null,
  right: ScreenSourceSpec | null,
) {
  if (!left || !right) return left === right
  return (
    left.sourceId === right.sourceId &&
    left.width === right.width &&
    left.height === right.height &&
    left.fps === right.fps &&
    left.bitrate === right.bitrate &&
    left.audioBitrate === right.audioBitrate &&
    left.audioRequested === right.audioRequested
  )
}

function sameIntent(left: LocalMediaIntent | null, right: LocalMediaIntent) {
  if (!left) return false
  return (
    left.operationId === right.operationId &&
    left.envelopeRevision === right.envelopeRevision &&
    left.microphone.revision === right.microphone.revision &&
    left.microphone.state === right.microphone.state &&
    (left.microphone.state === 'off' ||
      (right.microphone.state !== 'off' &&
        left.microphone.muted === right.microphone.muted)) &&
    (left.microphone.state !== 'publish' ||
      (right.microphone.state === 'publish' &&
        left.microphone.audioBitrateKbps === right.microphone.audioBitrateKbps &&
        samePublisherCredentials(
          left.microphone.credentials,
          right.microphone.credentials,
        ))) &&
    left.screen.revision === right.screen.revision &&
    left.screen.state === right.screen.state &&
    (left.screen.state === 'off' ||
      (right.screen.state !== 'off' &&
        samePublisherCredentials(
          left.screen.credentials,
          right.screen.credentials,
        ) &&
        sameSource(left.screen.source, right.screen.source)))
  )
}

function sameMicrophoneRecord(
  left: LocalMediaIntent['microphone'],
  right: LocalMediaIntent['microphone'],
) {
  return (
    left.state === right.state &&
    (left.state === 'off' ||
      (right.state !== 'off' && left.muted === right.muted)) &&
    (left.state !== 'publish' ||
      (right.state === 'publish' &&
        left.audioBitrateKbps === right.audioBitrateKbps &&
        samePublisherCredentials(left.credentials, right.credentials)))
  )
}

function sameScreenRecord(
  left: LocalMediaIntent['screen'],
  right: LocalMediaIntent['screen'],
) {
  return (
    left.state === right.state &&
    (left.state === 'off' ||
      (right.state !== 'off' &&
        samePublisherCredentials(left.credentials, right.credentials) &&
        sameSource(left.source, right.source)))
  )
}

function sameLease(
  left: LiveKitNativeCredentialLease | null,
  right: LiveKitNativeCredentialLease,
) {
  if (!left) return false
  return (
    left.operationId === right.operationId &&
    left.channelId === right.channelId &&
    samePublisherCredentials(
      left.credentials.microphone,
      right.credentials.microphone,
    ) &&
    samePublisherCredentials(left.credentials.screen, right.credentials.screen) &&
    samePublisherCredentials(left.credentials.camera, right.credentials.camera)
  )
}

export function createVoiceNativeMediaOwner(): VoiceNativeMediaOwner {
  let getDesktop: (() => SyrnikeDesktopApi | null | undefined) | null = null
  let unsubscribeLocalMediaState: (() => void) | null = null
  let callbacks: VoiceNativeMediaCallbacks = {}
  let context: VoiceNativeMediaContext = {
    operationId: null,
    channelId: null,
  }
  let lease: LiveKitNativeCredentialLease | null = null
  let envelopeRevision = 0
  let lastAppliedIntent: LocalMediaIntent | null = null
  let pendingApplication: VoiceNativeMediaApplication | null = null
  let applyRun = 0
  let waiters: VoiceNativeMediaWaiter[] = []

  let microphoneDesired: VoiceNativeMicrophoneDesired = {
    enabled: false,
    muted: false,
    audioBitrateKbps: 64,
    revision: 0,
  }
  let screenDesired: VoiceNativeScreenDesired = {
    state: 'off',
    revision: 0,
    source: null,
  }
  let microphoneObserved: VoiceNativeMicrophoneObserved = {
    operationId: null,
    revision: 0,
    sequence: -1,
    state: 'off',
    muted: false,
    participantIdentity: null,
  }
  let microphoneObservedEvent: Extract<
    LocalMediaObservedStateEvent,
    { kind: 'microphone' }
  > | null = null
  let screenObserved: VoiceNativeScreenObserved = {
    operationId: null,
    revision: 0,
    sequence: -1,
    state: 'off',
    participantIdentity: null,
  }
  let screenObservedEvent: VoiceNativeScreenObservedEvent | null = null

  function clearWaiters(message: string) {
    const activeWaiters = waiters
    waiters = []
    for (const waiter of activeWaiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(message))
    }
  }

  function rejectSupersededScreenWaiters(
    currentRevision: number,
    message = 'Native screen share intent was superseded',
    rejectCurrentRevision = false,
  ) {
    const remaining: VoiceNativeMediaWaiter[] = []
    for (const waiter of waiters) {
      if (
        waiter.kind !== 'screen' ||
        (!rejectCurrentRevision && waiter.revision === currentRevision)
      ) {
        remaining.push(waiter)
        continue
      }
      clearTimeout(waiter.timer)
      waiter.reject(new Error(message))
    }
    waiters = remaining
  }

  function rejectSupersededMicrophoneWaiters(
    currentRevision: number,
    message = 'Native microphone intent was superseded',
    rejectCurrentRevision = false,
  ) {
    const remaining: VoiceNativeMediaWaiter[] = []
    for (const waiter of waiters) {
      if (
        waiter.kind !== 'microphone' ||
        (!rejectCurrentRevision && waiter.revision === currentRevision)
      ) {
        remaining.push(waiter)
        continue
      }
      clearTimeout(waiter.timer)
      waiter.reject(new Error(message))
    }
    waiters = remaining
  }

  function currentDesktop() {
    return getDesktop?.() ?? null
  }

  function reportIntentError(error: unknown, intent: LocalMediaIntent) {
    const normalized =
      error instanceof Error ? error : new Error(String(error))
    callbacks.onIntentError?.(normalized, intent)
  }

  function applyIntentInBackground() {
    const intent = buildIntent()
    void applyIntent(intent).catch((error) => {
      reportIntentError(error, intent)
    })
  }

  function buildIntent(): LocalMediaIntent {
    const operationId = context.operationId
    if (!operationId) {
      return {
        operationId: null,
        envelopeRevision,
        microphone: {
          revision: microphoneDesired.revision,
          state: 'off',
        },
        screen: {
          revision: screenDesired.revision,
          state: 'off',
        },
      }
    }

    const activeLease =
      lease?.operationId === operationId ? lease : null
    const microphone =
      !microphoneDesired.enabled
        ? { revision: microphoneDesired.revision, state: 'off' as const }
        : activeLease
          ? {
              revision: microphoneDesired.revision,
              state: 'publish' as const,
              credentials: activeLease.credentials.microphone,
              muted: microphoneDesired.muted,
              audioBitrateKbps: microphoneDesired.audioBitrateKbps,
            }
          : {
              revision: microphoneDesired.revision,
              state: 'retain' as const,
              muted: microphoneDesired.muted,
            }

    const screen =
      screenDesired.state === 'off' || !activeLease
        ? { revision: screenDesired.revision, state: 'off' as const }
        : {
            revision: screenDesired.revision,
            state: screenDesired.state,
            credentials: activeLease.credentials.screen,
            source: screenDesired.source,
          }

    return {
      operationId,
      envelopeRevision,
      microphone,
      screen,
    }
  }

  function applyIntent(intent = buildIntent()): Promise<void> {
    const desktop = currentDesktop()
    if (!desktop || desktop.platform.os !== 'win32') {
      return Promise.resolve()
    }
    if (sameIntent(lastAppliedIntent, intent)) {
      return Promise.resolve()
    }
    if (
      pendingApplication &&
      sameIntent(pendingApplication.intent, intent)
    ) {
      return pendingApplication.promise
    }
    const run = ++applyRun
    const application: VoiceNativeMediaApplication = {
      intent,
      promise: Promise.resolve(),
    }
    const promise = (async () => {
      try {
        await desktop.media.applyLocalMediaIntent(intent)
        if (run !== applyRun) {
          return
        }
        lastAppliedIntent = intent
      } catch (error) {
        if (run !== applyRun) {
          return
        }
        throw error
      } finally {
        if (pendingApplication === application) {
          pendingApplication = null
        }
      }
    })()
    application.promise = promise
    pendingApplication = application
    return promise
  }

  function consumeWaiters(event: LocalMediaObservedStateEvent) {
    const remaining: VoiceNativeMediaWaiter[] = []
    for (const waiter of waiters) {
      if (
        waiter.kind === event.kind &&
        waiter.operationId === event.operationId &&
        waiter.revision === event.revision &&
        waiter.states.has(event.state)
      ) {
        clearTimeout(waiter.timer)
        waiter.resolve(event)
        continue
      }
      if (
        waiter.kind === event.kind &&
        waiter.operationId === event.operationId &&
        waiter.revision === event.revision &&
        event.state === 'error'
      ) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error(event.errorMessage))
        continue
      }
      remaining.push(waiter)
    }
    waiters = remaining
  }

  function acceptEvent(event: LocalMediaObservedStateEvent) {
    const desiredRevision =
      event.kind === 'microphone'
        ? microphoneDesired.revision
        : screenDesired.revision
    const desiredOperationId = buildIntent().operationId
    if (event.revision !== desiredRevision) {
      return false
    }
    if (event.operationId !== desiredOperationId) {
      return false
    }
    if (event.kind === 'microphone') {
      return event.sequence > microphoneObserved.sequence
    }
    return event.sequence > screenObserved.sequence
  }

  function handleObservedState(event: LocalMediaObservedStateEvent) {
    if (!acceptEvent(event)) {
      return
    }

    if (event.kind === 'microphone') {
      microphoneObserved = {
        operationId: event.operationId,
        revision: event.revision,
        sequence: event.sequence,
        state: event.state,
        muted: event.muted,
        participantIdentity: event.participantIdentity,
      }
      microphoneObservedEvent = event
      callbacks.onMicrophoneState?.(event)
    } else {
      screenObserved = {
        operationId: event.operationId,
        revision: event.revision,
        sequence: event.sequence,
        state: event.state,
        participantIdentity: event.participantIdentity,
      }
      screenObservedEvent = event
      callbacks.onScreenState?.(event)
    }

    consumeWaiters(event)
  }

  function bumpEnvelope() {
    envelopeRevision += 1
  }

  function bumpKindRevisionsForEffectiveChange(
    previousIntent: LocalMediaIntent,
    nextIntent: LocalMediaIntent,
  ) {
    if (!sameMicrophoneRecord(previousIntent.microphone, nextIntent.microphone)) {
      microphoneDesired = {
        ...microphoneDesired,
        revision: microphoneDesired.revision + 1,
      }
      rejectSupersededMicrophoneWaiters(microphoneDesired.revision)
    }
    if (!sameScreenRecord(previousIntent.screen, nextIntent.screen)) {
      screenDesired = {
        ...screenDesired,
        revision: screenDesired.revision + 1,
      }
      rejectSupersededScreenWaiters(screenDesired.revision)
    }
  }

  return {
    bindDesktop(nextGetDesktop, nextCallbacks = {}) {
      getDesktop = nextGetDesktop
      callbacks = nextCallbacks
      unsubscribeLocalMediaState?.()
      const desktop = currentDesktop()
      unsubscribeLocalMediaState =
        desktop?.media.onLocalMediaState((event) => {
          handleObservedState(event)
        }) ?? null

      return () => {
        unsubscribeLocalMediaState?.()
        unsubscribeLocalMediaState = null
        callbacks = {}
        getDesktop = null
        clearWaiters('Desktop local media observer was disposed')
      }
    },

    setVoiceContext(nextContext) {
      if (
        context.operationId === nextContext.operationId &&
        context.channelId === nextContext.channelId
      ) {
        applyIntentInBackground()
        return
      }
      const previousIntent = buildIntent()
      const operationChanged = context.operationId !== nextContext.operationId
      context = nextContext
      if (lease?.operationId !== context.operationId) {
        lease = null
      }
      bumpKindRevisionsForEffectiveChange(previousIntent, buildIntent())
      if (operationChanged) {
        rejectSupersededMicrophoneWaiters(
          microphoneDesired.revision,
          'Voice operation changed while microphone was publishing',
          true,
        )
        rejectSupersededScreenWaiters(
          screenDesired.revision,
          'Voice operation changed while screen share was starting',
          true,
        )
      }
      bumpEnvelope()
      applyIntentInBackground()
    },

    setLiveKitCredentials(nextLease) {
      if (
        !context.operationId ||
        nextLease.operationId !== context.operationId ||
        nextLease.channelId !== context.channelId
      ) {
        return
      }
      if (sameLease(lease, nextLease)) {
        applyIntentInBackground()
        return
      }
      const previousIntent = buildIntent()
      lease = nextLease
      bumpKindRevisionsForEffectiveChange(previousIntent, buildIntent())
      bumpEnvelope()
      applyIntentInBackground()
    },

    async syncMicrophone(input) {
      if (
        microphoneDesired.enabled === input.enabled &&
        microphoneDesired.muted === input.muted &&
        microphoneDesired.audioBitrateKbps === input.audioBitrateKbps
      ) {
        await applyIntent()
        return context.operationId ? microphoneDesired.revision : null
      }
      microphoneDesired = {
        enabled: input.enabled,
        muted: input.muted,
        audioBitrateKbps: input.audioBitrateKbps,
        revision: microphoneDesired.revision + 1,
      }
      bumpEnvelope()
      await applyIntent()
      return context.operationId ? microphoneDesired.revision : null
    },

    waitForMicrophonePublished(
      revision,
      timeoutMs = MICROPHONE_WAIT_TIMEOUT_MS,
    ) {
      return new Promise((resolve, reject) => {
        const operationId = context.operationId
        if (!operationId || revision !== microphoneDesired.revision) {
          reject(new Error('Native microphone intent was superseded'))
          return
        }
        const currentEvent =
          microphoneObserved.operationId === operationId &&
          microphoneObserved.revision === revision &&
          microphoneObserved.state === 'published' &&
          microphoneObservedEvent?.state === 'published'
            ? microphoneObservedEvent
            : null
        if (currentEvent) {
          resolve(currentEvent)
          return
        }

        const waiter: VoiceNativeMediaWaiter = {
          kind: 'microphone',
          operationId,
          revision,
          states: new Set(['published']),
          resolve: (event) =>
            resolve(
              event as Extract<
                LocalMediaObservedStateEvent,
                { kind: 'microphone' }
              >,
            ),
          reject,
          timer: setTimeout(() => {
            waiters = waiters.filter((candidate) => candidate !== waiter)
            reject(new Error('Native microphone publication timed out'))
          }, timeoutMs),
        }
        waiters.push(waiter)
      })
    },

    async setDesiredMicrophoneMuted(muted) {
      if (microphoneDesired.muted === muted) {
        await applyIntent()
        return
      }
      microphoneDesired = {
        ...microphoneDesired,
        muted,
        revision: microphoneDesired.revision + 1,
      }
      bumpEnvelope()
      await applyIntent()
    },

    async prepareScreenShare(source) {
      if (
        screenDesired.state === 'prepare' &&
        sameSource(screenDesired.source, source)
      ) {
        await applyIntent()
        return screenDesired.revision
      }
      screenDesired = {
        state: 'prepare',
        source,
        revision: screenDesired.revision + 1,
      }
      rejectSupersededScreenWaiters(screenDesired.revision)
      bumpEnvelope()
      await applyIntent()
      return screenDesired.revision
    },

    async publishScreenShare(source) {
      if (
        screenDesired.state === 'publish' &&
        sameSource(screenDesired.source, source)
      ) {
        await applyIntent()
        return screenDesired.revision
      }
      screenDesired = {
        state: 'publish',
        source,
        revision: screenDesired.revision + 1,
      }
      rejectSupersededScreenWaiters(screenDesired.revision)
      bumpEnvelope()
      await applyIntent()
      return screenDesired.revision
    },

    async stopScreenShare() {
      if (screenDesired.state === 'off') {
        await applyIntent()
        return screenDesired.revision
      }
      screenDesired = {
        state: 'off',
        source: null,
        revision: screenDesired.revision + 1,
      }
      rejectSupersededScreenWaiters(screenDesired.revision)
      bumpEnvelope()
      await applyIntent()
      return screenDesired.revision
    },

    waitForScreenState(revision, states, timeoutMs = SCREEN_WAIT_TIMEOUT_MS) {
      return new Promise((resolve, reject) => {
        const operationId = context.operationId
        if (!operationId || revision !== screenDesired.revision) {
          reject(new Error('Native screen share intent was superseded'))
          return
        }
        const currentEvent =
          screenObserved.operationId === operationId &&
          screenObserved.revision === revision &&
          states.includes(screenObserved.state) &&
          screenObservedEvent
            ? screenObservedEvent
            : null
        if (currentEvent) {
          resolve(currentEvent)
          return
        }

        const waiter: VoiceNativeMediaWaiter = {
          kind: 'screen',
          operationId,
          revision,
          states: new Set(states),
          resolve: (event) =>
            resolve(event as Extract<LocalMediaObservedStateEvent, { kind: 'screen' }>),
          reject,
          timer: setTimeout(() => {
            waiters = waiters.filter((candidate) => candidate !== waiter)
            reject(new Error('Native screen share state timed out'))
          }, timeoutMs),
        }
        waiters.push(waiter)
      })
    },

    reset() {
      if (
        lease === null &&
        !microphoneDesired.enabled &&
        microphoneDesired.muted === false &&
        screenDesired.state === 'off'
      ) {
        applyIntentInBackground()
        clearWaiters('Voice local media was reset')
        return
      }
      const previousIntent = buildIntent()
      lease = null
      microphoneDesired = {
        enabled: false,
        muted: false,
        audioBitrateKbps: microphoneDesired.audioBitrateKbps,
        revision: microphoneDesired.revision,
      }
      screenDesired = {
        state: 'off',
        source: null,
        revision: screenDesired.revision,
      }
      bumpKindRevisionsForEffectiveChange(previousIntent, buildIntent())
      bumpEnvelope()
      applyIntentInBackground()
      clearWaiters('Voice local media was reset')
    },

    hasActiveMicrophone(channelId) {
      if (
        channelId == null ||
        context.channelId !== channelId ||
        microphoneObserved.operationId !== context.operationId ||
        microphoneObserved.revision !== microphoneDesired.revision
      ) {
        return false
      }
      return microphoneObserved.state === 'published'
    },

    hasMicrophonePublishing(channelId) {
      if (
        channelId == null ||
        context.channelId !== channelId ||
        microphoneObserved.operationId !== context.operationId ||
        microphoneObserved.revision !== microphoneDesired.revision ||
        microphoneObserved.muted
      ) {
        return false
      }
      return microphoneObserved.state === 'published'
    },

    isMicrophoneMuted() {
      return microphoneDesired.muted
    },

    hasObservedMicrophone() {
      return (
        microphoneObserved.operationId === context.operationId &&
        microphoneObserved.revision === microphoneDesired.revision &&
        microphoneObserved.state === 'published'
      )
    },

    getScreenParticipantIdentity() {
      return screenObserved.participantIdentity
    },
  }
}
