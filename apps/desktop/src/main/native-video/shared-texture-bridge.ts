import { sharedTexture, type BrowserWindow } from 'electron'
import { Duration, Effect, Fiber, Schedule } from 'effect'

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

export type NativeVideoPresentationMetrics = {
  retainedFrames: number
  retainedBytes: number
  trackActiveReferences: number
  trackRetainedReferences: number
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
  deliveryFailureThreshold?: number
  deliveryFailureCooldownMs?: number
  releaseAttempts?: number
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
  released: boolean
  active: boolean
  importedAtMs: number
  stallTimer: Fiber.Fiber<void, never> | null
}

type ReleaseOperation = {
  frame: NativeSharedVideoRelease
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
      if (this.runtimeEpoch === null) {
        this.runtimeEpoch = frame.runtimeEpoch
      } else if (this.runtimeEpoch !== frame.runtimeEpoch) {
        this.runtimeEpoch = frame.runtimeEpoch
        this.cancelReleaseOperations((operation) =>
          operation.frame.runtimeEpoch !== frame.runtimeEpoch
        )
        this.rendererEpoch += 1
        this.releaseMainReferences()
        this.latestSequence.clear()
        this.deliveryFailures.clear()
        this.lastDeliveryRecoveryAt.clear()
      }
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
      const importTexture = this.dependencies.importTexture ??
        sharedTexture.importSharedTexture.bind(sharedTexture)
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
        released: false,
        active: true,
        importedAtMs: this.now(),
        stallTimer: null,
      }
      this.inFlight.set(key, entry)
      this.retainedBytes += frameBytes
      entry.stallTimer = yield* unrefSleep(
        Math.max(1_000, this.dependencies.stallTimeoutMs ?? 5_000),
      ).pipe(
        Effect.andThen(
          Effect.sync(() => this.recoverStalledTrack(key, trackKey, entry)),
        ),
        Effect.forkDetach,
      )
      const rendererEpoch = this.rendererEpoch
      const sendTexture = this.dependencies.sendTexture ??
        sharedTexture.sendSharedTexture.bind(sharedTexture)
      return yield* Effect.tryPromise({
        try: () =>
          sendTexture(
            {
              frame: window.webContents.mainFrame,
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
            },
          ),
        catch: (error) => error,
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            this.deliveredFrames += 1
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
        Effect.ensuring(
          Effect.sync(() => this.releaseEntryMainReference(key, entry)),
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
    if (entry.stallTimer) {
      Effect.runFork(Fiber.interrupt(entry.stallTimer))
      entry.stallTimer = null
    }
    this.releaseEntryMainReference(key, entry)
  }

  private releaseEntryMainReference(key: string, entry: Entry) {
    if (entry.released) return
    entry.released = true
    entry.imported.release()
    // Keep the entry until all renderer/VideoFrame GPU references are fenced.
  }

  private finishNativeRelease(key: string) {
    const entry = this.inFlight.get(key)
    if (!entry) return
    if (entry.stallTimer) Effect.runFork(Fiber.interrupt(entry.stallTimer))
    entry.stallTimer = null
    this.inFlight.delete(key)
    this.retainedBytes = Math.max(
      0,
      this.retainedBytes - entry.frame.width * entry.frame.height * 4,
    )
    this.releaseNativeFrame(entry.frame)
  }

  private releaseNativeFrame(frame: NativeSharedVideoRelease) {
    const key = releaseKey(frame)
    if (this.releaseOperations.has(key)) return
    const attempts = Math.max(1, this.dependencies.releaseAttempts ?? 6)
    const retrySchedule = Schedule.exponential(100).pipe(
      Schedule.modifyDelay(({ duration }) =>
        Effect.succeed(Duration.min(duration, Duration.millis(1_000)))
      ),
    )
    let fiber: Fiber.Fiber<void, never>
    const release = Effect.tryPromise({
        try: async () => {
          await this.dependencies.release(frame)
        },
        catch: (cause) => cause,
      }).pipe(
      Effect.retry({
        times: attempts - 1,
        schedule: retrySchedule,
      }),
      Effect.catch((error) =>
        Effect.sync(() => {
          this.operationFailures += 1
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

  private recoverStalledTrack(key: string, trackKey: string, entry: Entry) {
    if (this.disposed || this.inFlight.get(key) !== entry || !entry.active) return
    const metrics = this.presentationMetrics(trackKey)
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
