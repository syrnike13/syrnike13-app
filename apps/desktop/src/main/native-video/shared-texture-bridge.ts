import { sharedTexture, type BrowserWindow } from 'electron'
import { Deferred, Effect, Fiber } from 'effect'

import {
  isMediaTimelineFrameSampled,
  type MediaIncidentTimeline,
  type MediaTimelineFrame,
} from './media-incident-timeline'

export type NativeVideoSource = 'camera' | 'screen'

export type NativeSharedVideoFrame = {
  sessionId: string
  generation: number
  trackId: string
  participantIdentity: string
  source: NativeVideoSource
  local: boolean
  sequence: number
  width: number
  height: number
  timestampUs: number
  runtimeEpoch: number
  /** NT handle duplicated by the utility process into this process. */
  ntHandle: Buffer
}

export type NativeSharedVideoRelease = Pick<
  NativeSharedVideoFrame,
  'sessionId' | 'generation' | 'trackId' | 'source' | 'sequence'
> & { runtimeEpoch: number; local: boolean }

export type NativeVideoPresentationStallReason =
  | 'shared-texture-fence'
  | 'renderer-delivery'
  | 'retained-budget-exhausted'
  | 'retired-fence-deadline'
  | 'retired-fence-recycle'

export type NativeVideoPresentationMetrics = {
  retainedFrames: number
  retainedBytes: number
  trackActiveReferences: number
  trackRetainedReferences: number
  trackRetiredReferences: number
  oldestRetainedAgeMs: number
  deliveredFrames: number
  rejectedFrames: number
  staleRejectedFrames: number
  capacityRejectedFrames: number
  operationFailures: number
  deliveryFailures: number
  maximumActiveReferences: number
  maximumTrackReferences: number
  maximumRetainedBytes: number
}

export type NativeSharedTextureOperationStage =
  | 'import'
  | 'send'
  | 'recover'
  | 'release'

export type SharedTextureBridgeDependencies = {
  getWindow(): BrowserWindow | null
  release(frame: NativeSharedVideoRelease): void | Promise<void>
  importTexture?: typeof sharedTexture.importSharedTexture
  sendTexture?: typeof sharedTexture.sendSharedTexture
  maxInFlight?: number
  maxRetainedBytes?: number
  stallTimeoutMs?: number
  retiredFenceReloadMs?: number
  retiredFenceRecycleMs?: number
  deliveryFailureThreshold?: number
  deliveryFailureCooldownMs?: number
  timeline?: MediaIncidentTimeline
  onPresentationStalled?: (
    frame: NativeSharedVideoFrame,
    reason: NativeVideoPresentationStallReason,
    metrics: NativeVideoPresentationMetrics,
  ) => void | Promise<void>
  onOperationFailed?: (
    stage: NativeSharedTextureOperationStage,
    frame: NativeSharedVideoFrame | NativeSharedVideoRelease,
    error: unknown,
    metrics: NativeVideoPresentationMetrics,
  ) => void
  now?: () => number
}

type Entry = {
  frame: NativeSharedVideoFrame
  imported: Electron.SharedTextureImported
  targetFrame: Electron.WebFrameMain
  ownerTermination: Deferred.Deferred<void>
  released: boolean
  sendInProgress: boolean
  mainReferenceReleaseRequested: boolean
  active: boolean
  importedAtMs: number
  recoveryReason?: NativeVideoPresentationStallReason
  stallTimer: Fiber.Fiber<void, never> | null
  rendererEpoch: number
  retiredAtMs: number | null
  retiredFenceStage: 'awaiting-reload' | 'awaiting-recycle' | 'complete'
}

type ReleaseOperation = {
  frame: NativeSharedVideoFrame
  fiber: Fiber.Fiber<void, never>
}

/**
 * Owns the main-process reference created from a duplicated NT handle. The native
 * texture is released only from Electron's allReferencesReleased fence.
 */
export class NativeSharedTextureBridge {
  private readonly inFlight = new Map<string, Entry>()
  private readonly latestSequence = new Map<string, number>()
  private readonly deliveryFailures = new Map<string, number>()
  private readonly lastDeliveryRecoveryAt = new Map<string, number>()
  private readonly releaseOperations = new Map<string, ReleaseOperation>()
  private rendererEpoch = 0
  private runtimeEpoch: number | null = null
  private retainedBytes = 0
  private deliveredFrames = 0
  private rejectedFrames = 0
  private staleRejectedFrames = 0
  private capacityRejectedFrames = 0
  private operationFailures = 0
  private disposed = false
  private lastFailureReportAt = 0
  private lastCapacityReportAt = 0
  private retiredFenceReaper: Fiber.Fiber<void, never> | null = null
  private retiredFenceReaperRevision = 0

  constructor(private readonly dependencies: SharedTextureBridgeDependencies) {}

  get inFlightCount() {
    return this.inFlight.size
  }

  get retainedByteCount() {
    return this.retainedBytes
  }

  rendererReloaded() {
    this.rendererEpoch += 1
    this.releaseMainReferences()
    this.settleTerminatedRendererOwners()
    this.deliveryFailures.clear()
    this.lastDeliveryRecoveryAt.clear()
  }

  rendererOwnerTerminated() {
    this.settleTerminatedRendererOwners()
  }

  runtimeReplaced(runtimeEpoch: number) {
    if (!Number.isSafeInteger(runtimeEpoch) || runtimeEpoch < 0) return
    if (this.runtimeEpoch !== null && runtimeEpoch <= this.runtimeEpoch) return
    const previousEpoch = this.runtimeEpoch
    this.runtimeEpoch = runtimeEpoch
    if (previousEpoch === null) return
    this.cancelReleaseOperations((operation) =>
      operation.frame.runtimeEpoch < runtimeEpoch
    )
    this.rendererEpoch += 1
    this.releaseMainReferences()
    this.latestSequence.clear()
    this.deliveryFailures.clear()
    this.lastDeliveryRecoveryAt.clear()
  }

  resetSession(sessionId: string, generation: number) {
    const prefix = `${sessionId}:${generation}:`
    for (const [key, entry] of this.inFlight) {
      if (key.startsWith(prefix)) this.retireEntry(key, entry)
    }
    for (const values of [
      this.latestSequence,
      this.deliveryFailures,
      this.lastDeliveryRecoveryAt,
    ]) {
      for (const key of values.keys()) {
        if (key.startsWith(prefix)) values.delete(key)
      }
    }
  }

  removeTrack(sessionId: string, generation: number, trackId: string) {
    const prefix = `${sessionId}:${generation}:${trackId}:`
    for (const [key, entry] of this.inFlight) {
      if (key.startsWith(prefix)) this.retireEntry(key, entry)
    }
    for (const key of this.latestSequence.keys()) {
      if (key.startsWith(prefix)) this.latestSequence.delete(key)
    }
    for (const key of this.deliveryFailures.keys()) {
      if (key.startsWith(prefix)) this.deliveryFailures.delete(key)
    }
    for (const key of this.lastDeliveryRecoveryAt.keys()) {
      if (key.startsWith(prefix)) this.lastDeliveryRecoveryAt.delete(key)
    }
  }

  deliver(frame: NativeSharedVideoFrame) {
    return Effect.runPromise(this.deliverEffect(frame))
  }

  deliverEffect(frame: NativeSharedVideoFrame) {
    return Effect.gen({ self: this }, function*() {
      if (this.disposed || !this.isValid(frame)) {
        this.rejectedFrames += 1
        this.releaseNativeFrame(frame)
        return false
      }
      if (this.runtimeEpoch !== null && frame.runtimeEpoch < this.runtimeEpoch) {
        this.rejectedFrames += 1
        return false
      }
      this.runtimeReplaced(frame.runtimeEpoch)
      const trackKey = [
        frame.sessionId,
        frame.generation,
        frame.trackId,
        frame.runtimeEpoch,
      ].join(':')
      const previous = this.latestSequence.get(trackKey) ?? -1
      if (frame.sequence <= previous) {
        this.rejectedFrames += 1
        this.staleRejectedFrames += 1
        this.releaseNativeFrame(frame)
        return false
      }
      this.latestSequence.set(trackKey, frame.sequence)

      const window = this.dependencies.getWindow()
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
        this.rejectedFrames += 1
        this.releaseNativeFrame(frame)
        return false
      }
      const maximum = Math.max(1, this.dependencies.maxInFlight ?? 3)
      const references = this.unfencedTrackReferences(trackKey)
      // Permit one replacement generation after retiring a stalled track, but
      // keep the combined active + renderer-owned references strictly bounded.
      // Retired fences must not block every frame from the recovery track.
      if (references.total >= maximum * 2) {
        this.rejectedFrames += 1
        this.capacityRejectedFrames += 1
        this.recordRetainedBudgetExhaustion(trackKey, frame)
        this.releaseNativeFrame(frame)
        return false
      }
      if (references.active >= maximum) {
        this.rejectedFrames += 1
        this.capacityRejectedFrames += 1
        this.recordDeliveryFailure(trackKey, frame)
        this.releaseNativeFrame(frame)
        return false
      }
      const frameBytes = frame.width * frame.height * 4
      const maximumRetainedBytes = Math.max(
        1,
        this.dependencies.maxRetainedBytes ?? 256 * 1024 * 1024,
      )
      if (
        !Number.isSafeInteger(frameBytes) ||
        this.retainedBytes + frameBytes > maximumRetainedBytes
      ) {
        this.rejectedFrames += 1
        this.capacityRejectedFrames += 1
        this.reportCapacityLimit(frameBytes, maximumRetainedBytes)
        this.recordDeliveryFailure(trackKey, frame)
        this.releaseNativeFrame(frame)
        return false
      }
      const key = `${trackKey}:${frame.sequence}`
      const rendererEpoch = this.rendererEpoch
      const targetFrame = window.webContents.mainFrame
      const ownerTermination = yield* Deferred.make<void>()
      const importTexture = this.dependencies.importTexture ??
        sharedTexture.importSharedTexture.bind(sharedTexture)
      const importStartedAtMs = this.now()
      const imported = yield* Effect.try({
        try: () =>
          importTexture({
            textureInfo: {
              pixelFormat: 'bgra',
              codedSize: { width: frame.width, height: frame.height },
              visibleRect: {
                x: 0,
                y: 0,
                width: frame.width,
                height: frame.height,
              },
              timestamp: frame.timestampUs,
              handle: { ntHandle: frame.ntHandle },
            },
            allReferencesReleased: () => this.finishNativeRelease(key),
          }),
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            this.rejectedFrames += 1
            this.operationFailures += 1
            this.reportFailure('import', frame, error)
            this.recordDeliveryFailure(trackKey, frame)
            this.releaseNativeFrame(frame)
            return null
          }),
        ),
      )
      if (!imported) return false

      const entry: Entry = {
        frame,
        imported,
        targetFrame,
        ownerTermination,
        released: false,
        sendInProgress: true,
        mainReferenceReleaseRequested: false,
        active: true,
        importedAtMs: this.now(),
        stallTimer: null,
        rendererEpoch,
        retiredAtMs: null,
        retiredFenceStage: 'awaiting-reload',
      }
      this.inFlight.set(key, entry)
      this.retainedBytes += frameBytes
      this.recordTimeline('electron_imported', frame, {
        durationMs: this.now() - importStartedAtMs,
        metrics: this.presentationMetrics(trackKey),
      })
      entry.stallTimer = yield* unrefSleep(
        Math.max(1_000, this.dependencies.stallTimeoutMs ?? 5_000),
      ).pipe(
        Effect.andThen(
          Effect.sync(() => this.recoverStalledTrack(key, trackKey, entry)),
        ),
        Effect.forkDetach,
      )
      const sendTexture = this.dependencies.sendTexture ??
        sharedTexture.sendSharedTexture.bind(sharedTexture)
      const send = Effect.tryPromise({
        try: () =>
          sendTexture(
            {
              frame: targetFrame,
              importedSharedTexture: imported,
            },
            {
              sessionId: frame.sessionId,
              generation: frame.generation,
              trackId: frame.trackId,
              participantIdentity: frame.participantIdentity,
              source: frame.source,
              local: frame.local,
              sequence: frame.sequence,
              rendererEpoch,
              ...this.rendererTimelineMetadata(frame, entry),
            },
          ),
        catch: (error) => error,
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            this.deliveredFrames += 1
            this.recordTimeline('renderer_handoff', frame, {
              durationMs: this.now() - entry.importedAtMs,
              metrics: this.presentationMetrics(trackKey),
            })
          })
        ),
        Effect.as(true),
        Effect.catch((error) =>
          Effect.sync(() => {
            this.rejectedFrames += 1
            this.operationFailures += 1
            this.reportFailure('send', frame, error)
            if (rendererEpoch === this.rendererEpoch) {
              this.recordDeliveryFailure(trackKey, frame)
            }
            return false
          }),
        ),
      )
      return yield* send.pipe(
        Effect.raceFirst(
          Deferred.await(ownerTermination).pipe(Effect.as(false)),
        ),
        Effect.ensuring(
          Effect.sync(() => this.finishEntrySend(key, entry)),
        ),
      )
    })
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.releaseMainReferences()
    this.latestSequence.clear()
    this.deliveryFailures.clear()
    this.lastDeliveryRecoveryAt.clear()
    this.cancelReleaseOperations()
    this.cancelRetiredFenceReaper()
    this.runtimeEpoch = null
  }

  private isValid(frame: NativeSharedVideoFrame) {
    return frame.sessionId.length > 0 && frame.trackId.length > 0 &&
      Number.isSafeInteger(frame.generation) && frame.generation >= 0 &&
      Number.isSafeInteger(frame.sequence) && frame.sequence >= 0 &&
      Number.isInteger(frame.width) && frame.width > 0 &&
      Number.isInteger(frame.height) && frame.height > 0 &&
      Buffer.isBuffer(frame.ntHandle) && frame.ntHandle.byteLength === 8
  }

  private releaseMainReferences() {
    for (const [key, entry] of this.inFlight) {
      this.retireEntry(key, entry)
    }
  }

  private retireEntry(key: string, entry: Entry) {
    entry.active = false
    entry.retiredAtMs ??= this.now()
    if (entry.stallTimer) {
      Effect.runFork(Fiber.interrupt(entry.stallTimer))
      entry.stallTimer = null
    }
    this.releaseEntryMainReference(key, entry)
    this.armRetiredFenceReaper()
  }

  private releaseEntryMainReference(key: string, entry: Entry) {
    entry.mainReferenceReleaseRequested = true
    this.flushEntryMainReferenceRelease(key, entry)
  }

  private flushEntryMainReferenceRelease(_key: string, entry: Entry) {
    if (!entry.mainReferenceReleaseRequested || entry.sendInProgress) return
    if (entry.released) return
    entry.released = true
    entry.imported.release()
    // Keep the entry until all renderer/VideoFrame GPU references are fenced.
  }

  private finishEntrySend(key: string, entry: Entry) {
    entry.sendInProgress = false
    this.releaseEntryMainReference(key, entry)
  }

  private rendererOwnerIsTerminated(entry: Entry) {
    return entry.targetFrame.isDestroyed() || entry.targetFrame.detached
  }

  private settleTerminatedRendererOwners() {
    for (const entry of this.inFlight.values()) {
      if (!entry.sendInProgress || !this.rendererOwnerIsTerminated(entry)) {
        continue
      }
      Effect.runFork(Deferred.succeed(entry.ownerTermination, undefined))
    }
  }

  private finishNativeRelease(key: string) {
    const entry = this.inFlight.get(key)
    if (!entry) return
    const metrics = this.presentationMetrics(trackKeyFor(entry.frame))
    const fenceLatencyMs = this.now() - entry.importedAtMs
    if (entry.stallTimer) Effect.runFork(Fiber.interrupt(entry.stallTimer))
    entry.stallTimer = null
    this.inFlight.delete(key)
    this.retainedBytes = Math.max(
      0,
      this.retainedBytes - entry.frame.width * entry.frame.height * 4,
    )
    this.recordTimeline('renderer_fenced', entry.frame, {
      ...(entry.recoveryReason ? { anomaly: entry.recoveryReason } : {}),
      durationMs: fenceLatencyMs,
      metrics,
    })
    this.releaseNativeFrame(entry.frame)
    this.armRetiredFenceReaper()
  }

  private releaseNativeFrame(frame: NativeSharedVideoFrame) {
    if (this.runtimeEpoch !== null && frame.runtimeEpoch < this.runtimeEpoch) {
      return
    }
    const key = releaseKey(frame)
    if (this.releaseOperations.has(key)) return
    const requestedAtMs = this.now()
    const correlatedFrame = timelineFrame(frame)
    this.recordTimeline('native_release_requested', correlatedFrame)
    let fiber: Fiber.Fiber<void, never>
    const release = Effect.tryPromise({
        try: async () => {
          await this.dependencies.release(frame)
        },
        catch: (cause) => cause,
      }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          this.recordTimeline('native_released', correlatedFrame, {
            durationMs: this.now() - requestedAtMs,
            outcome: 'acknowledged',
          })
        })
      ),
      Effect.catch((error) =>
        Effect.sync(() => {
          this.operationFailures += 1
          this.recordTimeline('native_release_timeout', correlatedFrame, {
            anomaly: 'native-release-timeout',
            durationMs: this.now() - requestedAtMs,
            outcome: 'timeout',
          })
          this.reportFailure('release', frame, error)
        })
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (this.releaseOperations.get(key)?.fiber === fiber) {
            this.releaseOperations.delete(key)
          }
        }),
      ),
    )
    fiber = Effect.runFork(release)
    this.releaseOperations.set(key, { frame, fiber })
  }

  private cancelReleaseOperations(
    predicate: (operation: ReleaseOperation) => boolean = () => true,
  ) {
    for (const [key, operation] of this.releaseOperations) {
      if (!predicate(operation)) continue
      this.releaseOperations.delete(key)
      Effect.runFork(Fiber.interrupt(operation.fiber))
    }
  }

  private unfencedTrackReferences(trackKey: string) {
    let active = 0
    let total = 0
    const prefix = `${trackKey}:`
    for (const [key, entry] of this.inFlight) {
      if (!key.startsWith(prefix)) continue
      total += 1
      if (entry.active) active += 1
    }
    return { active, total }
  }

  private retiredFenceDeadlines() {
    const reloadMs = Math.max(
      1,
      this.dependencies.retiredFenceReloadMs ?? 5_000,
    )
    return {
      reloadMs,
      recycleMs: Math.max(
        reloadMs + 1,
        this.dependencies.retiredFenceRecycleMs ?? 10_000,
      ),
    }
  }

  private cancelRetiredFenceReaper() {
    this.retiredFenceReaperRevision += 1
    if (!this.retiredFenceReaper) return
    Effect.runFork(Fiber.interrupt(this.retiredFenceReaper))
    this.retiredFenceReaper = null
  }

  private armRetiredFenceReaper() {
    this.cancelRetiredFenceReaper()
    if (this.disposed) return
    const { reloadMs, recycleMs } = this.retiredFenceDeadlines()
    let nextDueAt = Number.POSITIVE_INFINITY
    for (const entry of this.inFlight.values()) {
      if (entry.active || entry.retiredAtMs === null ||
        entry.retiredFenceStage === 'complete') continue
      nextDueAt = Math.min(
        nextDueAt,
        entry.retiredAtMs + (
          entry.retiredFenceStage === 'awaiting-reload'
            ? reloadMs
            : recycleMs
        ),
      )
    }
    if (!Number.isFinite(nextDueAt)) return

    const revision = this.retiredFenceReaperRevision
    const delayMs = Math.max(1, nextDueAt - this.now())
    let fiber: Fiber.Fiber<void, never>
    fiber = Effect.runFork(
      unrefSleep(delayMs).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (this.retiredFenceReaperRevision !== revision ||
              this.retiredFenceReaper !== fiber) return
            this.retiredFenceReaper = null
            this.reapRetiredRendererGenerations()
            this.armRetiredFenceReaper()
          }),
        ),
      ),
    )
    this.retiredFenceReaper = fiber
  }

  private reapRetiredRendererGenerations() {
    const groups = new Map<string, Entry[]>()
    for (const entry of this.inFlight.values()) {
      if (entry.active || entry.retiredAtMs === null ||
        entry.retiredFenceStage === 'complete') continue
      if (this.rendererOwnerIsTerminated(entry)) {
        Effect.runFork(Deferred.succeed(entry.ownerTermination, undefined))
        continue
      }
      const groupKey = `${entry.frame.runtimeEpoch}:${entry.rendererEpoch}`
      const group = groups.get(groupKey)
      if (group) group.push(entry)
      else groups.set(groupKey, [entry])
    }

    const now = this.now()
    const { reloadMs, recycleMs } = this.retiredFenceDeadlines()
    for (const entries of groups.values()) {
      const representative = entries.reduce((oldest, candidate) =>
        (candidate.retiredAtMs ?? now) < (oldest.retiredAtMs ?? now)
          ? candidate
          : oldest
      )
      const retiredAtMs = representative.retiredAtMs ?? now
      if (now >= retiredAtMs + recycleMs) {
        for (const entry of entries) {
          entry.recoveryReason = 'retired-fence-recycle'
          entry.retiredAtMs = now
        }
        this.notifyPresentationStalled(
          representative.frame,
          'retired-fence-recycle',
          this.presentationMetrics(trackKeyFor(representative.frame)),
        )
        continue
      }
      if (now < retiredAtMs + reloadMs ||
        !entries.some((entry) =>
          entry.retiredFenceStage === 'awaiting-reload'
        )) continue
      for (const entry of entries) {
        entry.retiredFenceStage = 'awaiting-recycle'
        entry.recoveryReason = 'retired-fence-deadline'
      }
      this.notifyPresentationStalled(
        representative.frame,
        'retired-fence-deadline',
        this.presentationMetrics(trackKeyFor(representative.frame)),
      )
    }
  }

  private recoverStalledTrack(key: string, trackKey: string, entry: Entry) {
    if (this.disposed || this.inFlight.get(key) !== entry || !entry.active) return
    const metrics = this.presentationMetrics(trackKey)
    entry.recoveryReason = 'shared-texture-fence'
    const prefix = `${trackKey}:`
    for (const [candidateKey, candidate] of this.inFlight) {
      if (!candidate.active || !candidateKey.startsWith(prefix)) continue
      this.retireEntry(candidateKey, candidate)
    }
    this.rendererEpoch += 1
    this.deliveryFailures.set(trackKey, 0)
    if (!this.claimPresentationRecovery(trackKey)) return
    console.warn('[native-video] shared texture fence stalled; retiring renderer generation', {
      local: entry.frame.local,
      source: entry.frame.source,
      trackId: entry.frame.trackId,
      retainedFrames: this.inFlight.size,
      retainedBytes: this.retainedBytes,
    })
    this.notifyPresentationStalled(
      entry.frame,
      'shared-texture-fence',
      metrics,
    )
  }

  private recordDeliveryFailure(
    trackKey: string,
    frame: NativeSharedVideoFrame,
  ) {
    const failures = (this.deliveryFailures.get(trackKey) ?? 0) + 1
    this.deliveryFailures.set(trackKey, failures)
    const threshold = Math.max(
      1,
      this.dependencies.deliveryFailureThreshold ?? 3,
    )
    if (failures < threshold) return

    const metrics = this.presentationMetrics(trackKey, failures)
    this.deliveryFailures.set(trackKey, 0)
    if (!this.claimPresentationRecovery(trackKey)) return
    this.notifyPresentationStalled(frame, 'renderer-delivery', metrics)
  }

  private recordRetainedBudgetExhaustion(
    trackKey: string,
    frame: NativeSharedVideoFrame,
  ) {
    if (!this.claimPresentationRecovery(trackKey)) return
    this.notifyPresentationStalled(
      frame,
      'retained-budget-exhausted',
      this.presentationMetrics(trackKey),
    )
  }

  private notifyPresentationStalled(
    frame: NativeSharedVideoFrame,
    reason: NativeVideoPresentationStallReason,
    metrics: NativeVideoPresentationMetrics,
  ) {
    this.recordTimeline('renderer_recovery', frame, {
      anomaly: reason,
      durationMs: reason === 'shared-texture-fence'
        ? metrics.oldestRetainedAgeMs
        : undefined,
      metrics,
    })
    Effect.runFork(
      Effect.tryPromise({
        try: async () => {
          await this.dependencies.onPresentationStalled?.(
            frame,
            reason,
            metrics,
          )
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            this.operationFailures += 1
            this.reportFailure('recover', frame, error)
          })
        ),
      ),
    )
  }

  private claimPresentationRecovery(trackKey: string) {
    const now = this.now()
    const cooldown = Math.max(
      1_000,
      this.dependencies.deliveryFailureCooldownMs ?? 5_000,
    )
    const previous = this.lastDeliveryRecoveryAt.get(trackKey)
    if (previous !== undefined && now - previous < cooldown) {
      return false
    }
    this.lastDeliveryRecoveryAt.set(trackKey, now)
    return true
  }

  private reportFailure(
    stage: NativeSharedTextureOperationStage,
    frame: NativeSharedVideoFrame | NativeSharedVideoRelease,
    error: unknown,
  ) {
    const now = this.now()
    if (now - this.lastFailureReportAt < 10_000) return
    this.lastFailureReportAt = now
    const dimensions = 'width' in frame
      ? { width: frame.width, height: frame.height }
      : {}
    console.warn(`[native-video] shared texture ${stage} failed`, {
      local: frame.local,
      source: frame.source,
      trackId: frame.trackId,
      ...dimensions,
      error,
    })
    this.dependencies.onOperationFailed?.(
      stage,
      frame,
      error,
      this.presentationMetrics(trackKeyFor(frame)),
    )
  }

  private reportCapacityLimit(frameBytes: number, maximumRetainedBytes: number) {
    const now = this.now()
    if (now - this.lastCapacityReportAt < 10_000) return
    this.lastCapacityReportAt = now
    console.warn('[native-video] retained shared texture budget exhausted', {
      retainedFrames: this.inFlight.size,
      retainedBytes: this.retainedBytes,
      rejectedFrameBytes: frameBytes,
      maximumRetainedBytes,
    })
  }

  private presentationMetrics(
    trackKey: string,
    deliveryFailures = this.deliveryFailures.get(trackKey) ?? 0,
  ): NativeVideoPresentationMetrics {
    const references = this.unfencedTrackReferences(trackKey)
    const prefix = `${trackKey}:`
    let oldestImportedAtMs = this.now()
    let hasRetainedTrackFrame = false
    for (const [key, entry] of this.inFlight) {
      if (!key.startsWith(prefix)) continue
      hasRetainedTrackFrame = true
      oldestImportedAtMs = Math.min(oldestImportedAtMs, entry.importedAtMs)
    }
    const maximumActiveReferences = Math.max(
      1,
      this.dependencies.maxInFlight ?? 3,
    )
    return {
      retainedFrames: this.inFlight.size,
      retainedBytes: this.retainedBytes,
      trackActiveReferences: references.active,
      trackRetainedReferences: references.total,
      trackRetiredReferences: references.total - references.active,
      oldestRetainedAgeMs: hasRetainedTrackFrame
        ? Math.max(0, this.now() - oldestImportedAtMs)
        : 0,
      deliveredFrames: this.deliveredFrames,
      rejectedFrames: this.rejectedFrames,
      staleRejectedFrames: this.staleRejectedFrames,
      capacityRejectedFrames: this.capacityRejectedFrames,
      operationFailures: this.operationFailures,
      deliveryFailures,
      maximumActiveReferences,
      maximumTrackReferences: maximumActiveReferences * 2,
      maximumRetainedBytes: Math.max(
        1,
        this.dependencies.maxRetainedBytes ?? 256 * 1024 * 1024,
      ),
    }
  }

  private now() {
    return this.dependencies.now?.() ?? Date.now()
  }

  private recordTimeline(
    stage: Parameters<MediaIncidentTimeline['recordVideo']>[0],
    frame: NativeSharedVideoFrame | MediaTimelineFrame,
    observation: Parameters<MediaIncidentTimeline['recordVideo']>[2] = {},
  ) {
    const correlated = timelineFrame(frame)
    this.dependencies.timeline?.recordVideo(stage, correlated, {
      ...observation,
      ...(observation.metrics ? { metrics: { ...observation.metrics } } : {}),
    })
  }

  private rendererTimelineMetadata(
    frame: NativeSharedVideoFrame,
    entry: Entry,
  ) {
    const correlated = timelineFrame(frame)
    const peerAlias = this.dependencies.timeline?.correlate(correlated).peerAlias
    return {
      nativeCaptureTimestampUs: frame.timestampUs,
      runtimeEpoch: frame.runtimeEpoch,
      timelineSampled: isMediaTimelineFrameSampled(correlated),
      electronImportedAtMs: entry.importedAtMs,
      ...(peerAlias ? { peerAlias } : {}),
    }
  }
}

function timelineFrame(
  frame: NativeSharedVideoFrame | MediaTimelineFrame,
): MediaTimelineFrame {
  if ('nativeCaptureTimestampUs' in frame) return frame
  return {
    sessionId: frame.sessionId,
    generation: frame.generation,
    trackId: frame.trackId,
    participantIdentity: frame.participantIdentity,
    frameSequence: frame.sequence,
    nativeCaptureTimestampUs: frame.timestampUs,
    runtimeEpoch: frame.runtimeEpoch,
  }
}

function releaseKey(frame: NativeSharedVideoRelease) {
  return [
    frame.sessionId,
    frame.generation,
    frame.trackId,
    frame.source,
    frame.local ? 'local' : 'remote',
    frame.runtimeEpoch,
    frame.sequence,
  ].join(':')
}

function trackKeyFor(frame: NativeSharedVideoRelease) {
  return [
    frame.sessionId,
    frame.generation,
    frame.trackId,
    frame.runtimeEpoch,
  ].join(':')
}

function unrefSleep(delayMs: number) {
  return Effect.callback<void>((resume) => {
    const timer = setTimeout(() => resume(Effect.void), delayMs)
    timer.unref?.()
    return Effect.sync(() => clearTimeout(timer))
  })
}
