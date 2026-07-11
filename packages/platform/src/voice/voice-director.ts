import type {
  VoiceAuthorityAdapter,
  VoiceAuthorityEvent,
  VoiceCancellation,
} from './voice-authority'
import type {
  RtcEngineAdapter,
  VoiceDisconnectCause,
  VoiceEngineEvent,
} from './voice-engine'
import {
  computeEffectiveMuted,
  createInactiveMediaSnapshot,
  createInitialVoiceMediaDesiredState,
  type AuthoritativeVoiceSnapshot,
  type VoiceCommand,
  type VoiceFailure,
  type VoiceLease,
  type VoiceMediaDesiredState,
  type VoiceMediaKind,
  type VoiceRtcEngine,
  type VoiceSnapshot,
} from './voice-types'

const DEFAULT_COMMIT_TIMEOUT_MS = 20_000
const DEFAULT_RECOVERY_DELAYS_MS = [250, 1_000, ...Array(18).fill(5_000)]

export type VoiceDirectorOptions = Readonly<{
  authority: VoiceAuthorityAdapter
  engine: RtcEngineAdapter
  rtcEngine: VoiceRtcEngine
  clientInstanceId: string
  createOperationId?: () => string
  createConnectionEpoch?: () => string
  commitTimeoutMs?: number
  recoveryDelaysMs?: readonly number[]
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}>

type CommitWaiter = {
  lease: VoiceLease
  resolve: () => void
}

export class VoiceDirector {
  private readonly listeners = new Set<(snapshot: VoiceSnapshot) => void>()
  private readonly authority: VoiceAuthorityAdapter
  private readonly engine: RtcEngineAdapter
  private readonly rtcEngine: VoiceRtcEngine
  private readonly clientInstanceId: string
  private readonly createOperationId: () => string
  private readonly createConnectionEpoch: () => string
  private readonly commitTimeoutMs: number
  private readonly recoveryDelaysMs: readonly number[]
  private readonly delay: (milliseconds: number, signal: AbortSignal) => Promise<void>
  private readonly commitWaiters = new Set<CommitWaiter>()

  private desiredMedia = createInitialVoiceMediaDesiredState()
  private desiredChannelId: string | null = null
  private desiredRecipients: readonly string[] | undefined
  private desiredRevision = 0
  private activeLease: VoiceLease | null = null
  private forcedLease: VoiceLease | null = null
  private activeCommitted = false
  private latestAuthoritySnapshot: AuthoritativeVoiceSnapshot | null = null
  private transitionInProgress = false
  private recoveryRequested = false
  private reconcileRequested = false
  private reconcilePromise: Promise<void> | null = null
  private operationAbort: AbortController | null = null
  private selfStateRevision = 0
  private selfStateHandledRevision = 0
  private selfStateSync: Promise<void> | null = null
  private disposed = false
  private idCounter = 0

  private snapshotValue: VoiceSnapshot = {
    intentChannelId: null,
    membershipChannelId: null,
    connection: 'disconnected',
    microphone: createInactiveMediaSnapshot(),
    output: createInactiveMediaSnapshot(),
    camera: createInactiveMediaSnapshot(),
    screen: createInactiveMediaSnapshot(),
    screenAudio: createInactiveMediaSnapshot(),
    userMuted: this.desiredMedia.userMuted,
    userDeafened: this.desiredMedia.userDeafened,
    serverMuted: this.desiredMedia.serverMuted,
    serverDeafened: this.desiredMedia.serverDeafened,
    systemPrivacyMuted: this.desiredMedia.systemPrivacyMuted,
    monitoringMuted: this.desiredMedia.monitoringMuted,
    inputMode: this.desiredMedia.inputMode,
    pushToTalkHeld: this.desiredMedia.pushToTalkHeld,
    effectiveMuted: this.desiredMedia.effectiveMuted,
    speakingUserIds: [],
  }

  private readonly unsubscribeAuthority: () => void
  private readonly unsubscribeEngine: () => void

  constructor(options: VoiceDirectorOptions) {
    this.authority = options.authority
    this.engine = options.engine
    this.rtcEngine = options.rtcEngine
    this.clientInstanceId = requireIdentifier(
      options.clientInstanceId,
      'clientInstanceId',
    )
    this.createOperationId =
      options.createOperationId ?? (() => this.createUniqueId('voice-op'))
    this.createConnectionEpoch =
      options.createConnectionEpoch ?? (() => this.createUniqueId('voice-epoch'))
    this.commitTimeoutMs =
      options.commitTimeoutMs ?? DEFAULT_COMMIT_TIMEOUT_MS
    this.recoveryDelaysMs =
      options.recoveryDelaysMs ?? DEFAULT_RECOVERY_DELAYS_MS
    this.delay = options.delay ?? abortableDelay
    this.unsubscribeAuthority = this.authority.subscribe((event) =>
      this.handleAuthorityEvent(event),
    )
    this.unsubscribeEngine = this.engine.subscribe((event) =>
      this.handleEngineEvent(event),
    )
  }

  dispatch(command: VoiceCommand) {
    if (this.disposed) return
    switch (command.type) {
      case 'join':
        this.join(command.channelId, command.recipients)
        return
      case 'leave':
        this.forcedLease = null
        this.setIntent(null, false)
        return
      case 'retryVoice':
        if (!this.desiredChannelId || this.snapshotValue.connection !== 'failed') {
          return
        }
        this.recoveryRequested = false
        this.forcedLease = null
        this.bumpIntentRevision()
        return
      case 'retryMedia':
        this.engine.retryMedia(command.kind)
        return
      case 'setUserMuted':
        this.updateDesiredMedia({ userMuted: command.muted })
        return
      case 'setUserDeafened':
        this.updateDesiredMedia({ userDeafened: command.deafened })
        return
      case 'setInputMode':
        this.updateDesiredMedia({ inputMode: command.mode })
        return
      case 'setPushToTalkHeld':
        this.updateDesiredMedia({ pushToTalkHeld: command.held })
        return
      case 'setSystemPrivacyMuted':
        this.updateDesiredMedia({ systemPrivacyMuted: command.muted })
        return
      case 'setSelfMonitoringActive':
        this.updateDesiredMedia({ monitoringMuted: command.active })
        return
      case 'configureMicrophone':
        this.updateDesiredMedia({
          microphoneDeviceId: command.deviceId,
          noiseSuppression: command.noiseSuppression,
          echoCancellation: command.echoCancellation,
          inputVolume: command.inputVolume,
          voiceGateEnabled: command.voiceGateEnabled,
          voiceGateThresholdDb: command.voiceGateThresholdDb,
          voiceGateAutoThreshold: command.voiceGateAutoThreshold,
        })
        return
      case 'configureOutput':
        this.updateDesiredMedia({
          outputDeviceId: command.deviceId,
          outputVolume: command.volume,
        })
        return
      case 'configureRemoteAudio':
        this.engine.updateRemoteAudioSettings(command.settings)
        return
      case 'setCamera':
        this.updateDesiredMedia({
          cameraEnabled: command.enabled,
          cameraDeviceId: command.deviceId,
        })
        return
      case 'setScreen':
        this.updateDesiredMedia({
          screenEnabled: command.enabled,
          screenSourceId: command.sourceId,
          screenAudioEnabled: command.enabled && Boolean(command.audioEnabled),
          screenWidth: command.width,
          screenHeight: command.height,
          screenFps: command.fps,
          screenBitrate: command.bitrate,
          screenAudioBitrate: command.audioBitrate,
        })
        return
    }
  }

  snapshot() {
    return this.snapshotValue
  }

  subscribe(listener: (snapshot: VoiceSnapshot) => void) {
    this.listeners.add(listener)
    listener(this.snapshotValue)
    return () => this.listeners.delete(listener)
  }

  async waitForIdle() {
    while (this.reconcilePromise) await this.reconcilePromise
  }

  async shutdown(reason: 'app_exit' | 'sleep' | 'logout') {
    if (this.disposed) return
    this.desiredChannelId = null
    this.desiredRevision += 1
    this.recoveryRequested = false
    this.operationAbort?.abort(reason)
    this.updateSnapshot({ intentChannelId: null })
    this.requestReconcile()
    await this.waitForIdle()
  }

  async dispose() {
    if (this.disposed) return
    await this.shutdown('app_exit')
    this.disposed = true
    this.unsubscribeAuthority()
    this.unsubscribeEngine()
    this.listeners.clear()
    this.commitWaiters.clear()
  }

  private join(channelId: string, recipients?: readonly string[]) {
    const normalized = requireIdentifier(channelId, 'channelId')
    if (
      this.desiredChannelId === normalized &&
      this.snapshotValue.connection !== 'failed'
    ) {
      return
    }
    this.forcedLease = null
    this.desiredRecipients = recipients ? [...recipients] : undefined
    this.setIntent(normalized, false)
  }

  private setIntent(channelId: string | null, recovery: boolean) {
    this.desiredChannelId = channelId
    if (channelId === null) this.desiredRecipients = undefined
    this.recoveryRequested = recovery
    this.bumpIntentRevision()
  }

  private bumpIntentRevision() {
    this.desiredRevision += 1
    this.operationAbort?.abort('superseded')
    this.updateSnapshot({
      intentChannelId: this.desiredChannelId,
      failure: undefined,
      retryAttempt: undefined,
    })
    this.requestReconcile()
  }

  private requestReconcile() {
    this.reconcileRequested = true
    if (this.reconcilePromise) return
    this.reconcilePromise = this.runReconcileLoop().finally(() => {
      this.reconcilePromise = null
      if (this.reconcileRequested && !this.disposed) this.requestReconcile()
    })
  }

  private async runReconcileLoop() {
    while (this.reconcileRequested && !this.disposed) {
      this.reconcileRequested = false
      const revision = this.desiredRevision
      await this.reconcileOnce(revision)
    }
  }

  private async reconcileOnce(revision: number) {
    const target = this.desiredChannelId
    if (!target) {
      await this.disconnectCurrent('leave')
      if (revision !== this.desiredRevision) return
      this.updateSnapshot({
        connection: 'disconnected',
        membershipChannelId: null,
        speakingUserIds: [],
        operationId: undefined,
        connectionEpoch: undefined,
        retryAttempt: undefined,
        failure: undefined,
      })
      return
    }

    if (
      this.activeLease?.channelId === target &&
      this.activeCommitted &&
      this.snapshotValue.connection === 'connected'
    ) {
      return
    }

    if (this.activeLease) {
      await this.disconnectCurrent(
        this.activeLease.channelId === target ? 'recovery' : 'move',
      )
      if (revision !== this.desiredRevision) return
    }

    const recovery = this.recoveryRequested
    const delays = recovery ? this.recoveryDelaysMs : [0]
    let lastFailure: VoiceFailure | undefined

    for (let index = 0; index < delays.length; index += 1) {
      if (revision !== this.desiredRevision || target !== this.desiredChannelId) {
        return
      }

      const abort = new AbortController()
      this.operationAbort = abort
      const attempt = index + 1
      if (delays[index] > 0) {
        this.updateSnapshot({
          connection: 'recovering',
          retryAttempt: attempt,
          failure: lastFailure,
        })
        try {
          await this.delay(delays[index], abort.signal)
        } catch (error) {
          if (isAbortError(error)) return
          throw error
        }
      }

      try {
        await this.connectTarget(target, revision, recovery, attempt, abort)
        this.recoveryRequested = false
        return
      } catch (error) {
        if (
          isAbortError(error) ||
          revision !== this.desiredRevision ||
          target !== this.desiredChannelId
        ) {
          await this.cleanupFailedAttempt('superseded')
          return
        }
        lastFailure = normalizeFailure(error, 'voice_connect_failed')
        await this.cleanupFailedAttempt('connect_failed')
        if (!recovery || index === delays.length - 1) {
          this.updateSnapshot({
            connection: 'failed',
            membershipChannelId: null,
            retryAttempt: recovery ? attempt : undefined,
            failure: lastFailure,
          })
          return
        }
      } finally {
        if (this.operationAbort === abort) this.operationAbort = null
      }
    }
  }

  private async connectTarget(
    channelId: string,
    revision: number,
    recovery: boolean,
    attempt: number,
    abort: AbortController,
  ) {
    const suppliedLease =
      this.forcedLease?.channelId === channelId ? this.forcedLease : null
    if (suppliedLease) this.forcedLease = null
    const operationId = suppliedLease
      ? suppliedLease.operationId
      : requireIdentifier(this.createOperationId(), 'operationId')
    const connectionEpoch = suppliedLease
      ? suppliedLease.connectionEpoch
      : requireIdentifier(this.createConnectionEpoch(), 'connectionEpoch')
    this.transitionInProgress = true
    this.activeCommitted = false
    this.updateSnapshot({
      connection: recovery ? 'recovering' : 'connecting',
      speakingUserIds: [],
      operationId,
      connectionEpoch,
      retryAttempt: recovery ? attempt : undefined,
      failure: undefined,
      membershipChannelId: null,
    })

    try {
      const lease = suppliedLease ??
        (await this.authority.reserve(
          {
            channelId,
            rtcEngine: this.rtcEngine,
            clientInstanceId: this.clientInstanceId,
            operationId,
            connectionEpoch,
            media: this.desiredMedia,
            recipients: this.desiredRecipients,
            suppressCallNotifications: recovery,
          },
          abort.signal,
        ))
      assertLeaseMatches(lease, {
        channelId,
        rtcEngine: this.rtcEngine,
        clientInstanceId: this.clientInstanceId,
        operationId,
        connectionEpoch,
      })
      if (revision !== this.desiredRevision) throw abortError()
      this.activeLease = lease
      await this.engine.connect(lease, this.desiredMedia, abort.signal)
      if (revision !== this.desiredRevision) throw abortError()
      await this.waitForMembershipCommit(lease, abort.signal)
      if (revision !== this.desiredRevision) throw abortError()
      this.activeCommitted = true
      this.requestSelfStateSync()
      this.updateSnapshot({
        connection: 'connected',
        membershipChannelId: channelId,
        operationId,
        connectionEpoch,
        retryAttempt: undefined,
        failure: undefined,
      })
    } finally {
      this.transitionInProgress = false
    }
  }

  private async disconnectCurrent(cause: VoiceDisconnectCause) {
    const lease = this.activeLease
    if (!lease) return
    this.transitionInProgress = true
    this.activeLease = null
    this.activeCommitted = false
    try {
      await this.engine.disconnect(cause)
    } catch {
      // The adapter owns its two-second forced host-recycle deadline.
    } finally {
      await this.cancelLease(lease, cause === 'leave' ? 'leave' : 'superseded')
      this.transitionInProgress = false
    }
  }

  private async cleanupFailedAttempt(reason: VoiceCancellation['reason']) {
    const lease = this.activeLease
    this.activeLease = null
    this.activeCommitted = false
    try {
      await this.engine.disconnect('recovery')
    } catch {
      // A native adapter recycles an unresponsive media host here.
    }
    if (lease) await this.cancelLease(lease, reason)
  }

  private async cancelLease(
    lease: VoiceLease,
    reason: VoiceCancellation['reason'],
  ) {
    try {
      await this.authority.cancel({
        rtcEngine: lease.rtcEngine,
        clientInstanceId: lease.clientInstanceId,
        operationId: lease.operationId,
        connectionEpoch: lease.connectionEpoch,
        reason,
      })
    } catch {
      // Exact-operation cleanup is durable on the backend and safe to retry.
    }
  }

  private waitForMembershipCommit(lease: VoiceLease, signal: AbortSignal) {
    if (membershipMatchesLease(this.latestAuthoritySnapshot?.membership, lease)) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const waiter: CommitWaiter = {
        lease,
        resolve: () => finish(resolve),
      }
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        signal.removeEventListener('abort', onAbort)
        this.commitWaiters.delete(waiter)
        callback()
      }
      const onAbort = () => finish(() => reject(abortError()))
      const timeout = setTimeout(
        () =>
          finish(() =>
            reject(
              failureError({
                code: 'voice_commit_timeout',
                message: 'Voice membership commit timed out',
                retryable: true,
                stage: 'authority_commit',
              }),
            ),
          ),
        this.commitTimeoutMs,
      )
      signal.addEventListener('abort', onAbort, { once: true })
      this.commitWaiters.add(waiter)
      if (membershipMatchesLease(this.latestAuthoritySnapshot?.membership, lease)) {
        waiter.resolve()
      }
    })
  }

  private handleAuthorityEvent(event: VoiceAuthorityEvent) {
    if (this.disposed) return
    if (event.type === 'forcedMove') {
      this.handleForcedMove(event.from, event.lease)
      return
    }
    if (event.type !== 'snapshot') return
    const incoming = event.snapshot
    if (
      this.latestAuthoritySnapshot &&
      incoming.authorityVersion <= this.latestAuthoritySnapshot.authorityVersion
    ) {
      return
    }
    this.latestAuthoritySnapshot = incoming
    this.updateDesiredMedia(
      {
        serverMuted: incoming.serverMuted,
        serverDeafened: incoming.serverDeafened,
      },
    )
    for (const waiter of [...this.commitWaiters]) {
      if (membershipMatchesLease(incoming.membership, waiter.lease)) waiter.resolve()
    }

    const lease = this.activeLease
    if (
      !lease ||
      !this.activeCommitted ||
      this.transitionInProgress ||
      this.snapshotValue.connection !== 'connected'
    ) {
      return
    }
    if (membershipMatchesLease(incoming.membership, lease)) return
    if (incoming.authorityVersion <= lease.authorityVersion) return

    this.desiredChannelId = null
    this.recoveryRequested = false
    this.bumpIntentRevision()
  }

  private handleForcedMove(
    from: NonNullable<AuthoritativeVoiceSnapshot['membership']>,
    lease: VoiceLease,
  ) {
    const current = this.activeLease
    if (
      sameVoiceLease(this.forcedLease, lease) ||
      sameVoiceLease(current, lease)
    ) {
      return
    }
    const acceptsMove =
      current !== null &&
      this.activeCommitted &&
      !this.transitionInProgress &&
      membershipMatchesLease(from, current) &&
      lease.rtcEngine === this.rtcEngine &&
      lease.clientInstanceId === this.clientInstanceId &&
      lease.channelId !== current.channelId &&
      lease.authorityVersion > current.authorityVersion

    if (!acceptsMove) {
      void this.cancelLease(lease, 'superseded')
      return
    }

    this.forcedLease = lease
    this.desiredRecipients = undefined
    this.desiredChannelId = lease.channelId
    this.recoveryRequested = false
    this.bumpIntentRevision()
  }

  private handleEngineEvent(event: VoiceEngineEvent) {
    if (this.disposed) return
    const lease = this.activeLease
    if (
      !lease ||
      event.operationId !== lease.operationId ||
      event.connectionEpoch !== lease.connectionEpoch
    ) {
      return
    }
    if (event.type === 'mediaState') {
      this.updateMediaSnapshot(event.kind, event.media)
      return
    }
    if (event.type === 'transientReconnectStarted') {
      if (this.activeCommitted) this.updateSnapshot({ connection: 'recovering' })
      return
    }
    if (event.type === 'transientReconnectSucceeded') {
      if (this.activeCommitted) this.updateSnapshot({ connection: 'connected' })
      return
    }
    if (event.type === 'speakingChanged') {
      this.updateSnapshot({
        speakingUserIds: [...new Set(event.participantIdentities)],
      })
      return
    }
    if (event.type === 'terminalFailure') {
      if (!this.activeCommitted) return
      this.recoveryRequested = true
      this.desiredRevision += 1
      this.operationAbort?.abort('runtime_lost')
      this.updateSnapshot({
        connection: 'recovering',
        membershipChannelId: null,
        speakingUserIds: [],
        retryAttempt: 0,
        failure: event.failure,
      })
      this.requestReconcile()
    }
  }

  private updateDesiredMedia(
    patch: Partial<VoiceMediaDesiredState>,
  ) {
    const previousUserMuted = this.desiredMedia.userMuted
    const previousUserDeafened = this.desiredMedia.userDeafened
    const nextBase = { ...this.desiredMedia, ...patch }
    this.desiredMedia = {
      ...nextBase,
      effectiveMuted: computeEffectiveMuted(nextBase),
    }
    this.engine.updateDesiredMedia(this.desiredMedia)
    this.updateSnapshot({
      userMuted: this.desiredMedia.userMuted,
      userDeafened: this.desiredMedia.userDeafened,
      serverMuted: this.desiredMedia.serverMuted,
      serverDeafened: this.desiredMedia.serverDeafened,
      systemPrivacyMuted: this.desiredMedia.systemPrivacyMuted,
      monitoringMuted: this.desiredMedia.monitoringMuted,
      inputMode: this.desiredMedia.inputMode,
      pushToTalkHeld: this.desiredMedia.pushToTalkHeld,
      effectiveMuted: this.desiredMedia.effectiveMuted,
    })
    if (
      previousUserMuted !== this.desiredMedia.userMuted ||
      previousUserDeafened !== this.desiredMedia.userDeafened
    ) {
      this.requestSelfStateSync()
    }
  }

  private requestSelfStateSync() {
    this.selfStateRevision += 1
    this.ensureSelfStateSync()
  }

  private ensureSelfStateSync() {
    if (this.selfStateSync || !this.activeLease) return
    this.selfStateSync = this.runSelfStateSync().finally(() => {
      this.selfStateSync = null
      if (
        this.activeLease &&
        this.selfStateHandledRevision !== this.selfStateRevision
      ) {
        this.ensureSelfStateSync()
      }
    })
  }

  private async runSelfStateSync() {
    let handledRevision = -1
    while (this.activeLease && handledRevision !== this.selfStateRevision) {
      handledRevision = this.selfStateRevision
      const lease = this.activeLease
      const desired = this.desiredMedia
      try {
        await this.authority.updateSelfState({
          channelId: lease.channelId,
          rtcEngine: lease.rtcEngine,
          clientInstanceId: lease.clientInstanceId,
          operationId: lease.operationId,
          connectionEpoch: lease.connectionEpoch,
          userMuted: desired.userMuted,
          userDeafened: desired.userDeafened,
        })
      } catch {
        // The next full authority snapshot remains canonical. A reconnect or
        // later user change retries without touching the healthy RTC Room.
      }
      this.selfStateHandledRevision = handledRevision
    }
  }

  private updateMediaSnapshot(
    kind: VoiceMediaKind,
    media: VoiceSnapshot['microphone'],
  ) {
    const key = kind === 'screen_audio' ? 'screenAudio' : kind
    this.updateSnapshot({ [key]: media })
  }

  private updateSnapshot(patch: Partial<VoiceSnapshot>) {
    this.snapshotValue = { ...this.snapshotValue, ...patch }
    for (const listener of this.listeners) listener(this.snapshotValue)
  }

  private createUniqueId(prefix: string) {
    const uuid = globalThis.crypto?.randomUUID?.()
    if (uuid) return `${prefix}-${uuid}`
    this.idCounter += 1
    return `${prefix}-${Date.now().toString(36)}-${this.idCounter.toString(36)}`
  }
}

function sameVoiceLease(left: VoiceLease | null, right: VoiceLease) {
  return (
    left !== null &&
    left.channelId === right.channelId &&
    left.rtcEngine === right.rtcEngine &&
    left.clientInstanceId === right.clientInstanceId &&
    left.operationId === right.operationId &&
    left.connectionEpoch === right.connectionEpoch
  )
}

function requireIdentifier(value: string, field: string) {
  const normalized = value.trim()
  if (!normalized || normalized.length > 512) {
    throw new Error(`${field} must be a non-empty identifier`)
  }
  return normalized
}

function assertLeaseMatches(
  lease: VoiceLease,
  expected: Omit<VoiceLease, 'authorityVersion' | 'credential'>,
) {
  if (
    lease.channelId !== expected.channelId ||
    lease.rtcEngine !== expected.rtcEngine ||
    lease.clientInstanceId !== expected.clientInstanceId ||
    lease.operationId !== expected.operationId ||
    lease.connectionEpoch !== expected.connectionEpoch
  ) {
    throw failureError({
      code: 'voice_lease_mismatch',
      message: 'Voice authority returned a mismatched credential lease',
      retryable: false,
      stage: 'authority_reserve',
    })
  }
}

function membershipMatchesLease(
  membership: AuthoritativeVoiceSnapshot['membership'] | undefined,
  lease: VoiceLease,
) {
  return (
    membership?.channelId === lease.channelId &&
    membership.rtcEngine === lease.rtcEngine &&
    membership.clientInstanceId === lease.clientInstanceId &&
    membership.operationId === lease.operationId &&
    membership.connectionEpoch === lease.connectionEpoch
  )
}

function failureError(failure: VoiceFailure) {
  return Object.assign(new Error(failure.message), { failure })
}

function normalizeFailure(error: unknown, fallbackCode: string): VoiceFailure {
  if (error && typeof error === 'object' && 'failure' in error) {
    const failure = (error as { failure?: VoiceFailure }).failure
    if (failure) return failure
  }
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : 'Voice operation failed',
    retryable: true,
  }
}

function abortError() {
  return new DOMException('Voice operation superseded', 'AbortError')
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout)
      reject(abortError())
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
