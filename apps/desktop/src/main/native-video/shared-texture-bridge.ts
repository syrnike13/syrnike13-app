import { sharedTexture, type BrowserWindow } from 'electron'

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
  'sessionId' | 'generation' | 'trackId' | 'sequence'
> & { runtimeEpoch: number; local: boolean }

export type SharedTextureBridgeDependencies = {
  getWindow(): BrowserWindow | null
  release(frame: NativeSharedVideoRelease): void | Promise<void>
  importTexture?: typeof sharedTexture.importSharedTexture
  sendTexture?: typeof sharedTexture.sendSharedTexture
  maxInFlight?: number
  stallTimeoutMs?: number
  onTrackStalled?: (frame: NativeSharedVideoFrame) => void | Promise<void>
}

type Entry = {
  frame: NativeSharedVideoFrame
  imported: Electron.SharedTextureImported
  released: boolean
  active: boolean
  stallTimer: ReturnType<typeof setTimeout> | null
}

/**
 * Owns the main-process reference created from a duplicated NT handle. The native
 * texture is released only from Electron's allReferencesReleased fence.
 */
export class NativeSharedTextureBridge {
  private readonly inFlight = new Map<string, Entry>()
  private readonly latestSequence = new Map<string, number>()
  private rendererEpoch = 0
  private runtimeEpoch: number | null = null
  private disposed = false
  private lastFailureReportAt = 0

  constructor(private readonly dependencies: SharedTextureBridgeDependencies) {}

  get inFlightCount() {
    return this.inFlight.size
  }

  rendererReloaded() {
    this.rendererEpoch += 1
    this.releaseMainReferences()
  }

  removeTrack(sessionId: string, generation: number, trackId: string) {
    const prefix = `${sessionId}:${generation}:${trackId}:`
    for (const [key, entry] of this.inFlight) {
      if (key.startsWith(prefix)) this.retireEntry(key, entry)
    }
    for (const key of this.latestSequence.keys()) {
      if (key.startsWith(prefix)) this.latestSequence.delete(key)
    }
  }

  async deliver(frame: NativeSharedVideoFrame) {
    if (this.disposed || !this.isValid(frame)) {
      this.releaseNativeFrame(frame)
      return false
    }
    if (this.runtimeEpoch === null) {
      this.runtimeEpoch = frame.runtimeEpoch
    } else if (this.runtimeEpoch !== frame.runtimeEpoch) {
      this.runtimeEpoch = frame.runtimeEpoch
      this.rendererEpoch += 1
      this.releaseMainReferences()
      this.latestSequence.clear()
    }
    const trackKey = [
      frame.sessionId,
      frame.generation,
      frame.trackId,
      frame.runtimeEpoch,
    ].join(':')
    const previous = this.latestSequence.get(trackKey) ?? -1
    if (frame.sequence <= previous) {
      this.releaseNativeFrame(frame)
      return false
    }
    this.latestSequence.set(trackKey, frame.sequence)

    const window = this.dependencies.getWindow()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      this.releaseNativeFrame(frame)
      return false
    }
    const maximum = Math.max(1, this.dependencies.maxInFlight ?? 3)
    if (this.activeTrackReferences(trackKey) >= maximum) {
      this.releaseNativeFrame(frame)
      return false
    }
    const key = `${trackKey}:${frame.sequence}`
    const importTexture = this.dependencies.importTexture ??
      sharedTexture.importSharedTexture.bind(sharedTexture)
    let imported: Electron.SharedTextureImported
    try {
      imported = importTexture({
        textureInfo: {
          pixelFormat: 'bgra',
          codedSize: { width: frame.width, height: frame.height },
          visibleRect: { x: 0, y: 0, width: frame.width, height: frame.height },
          timestamp: frame.timestampUs,
          handle: { ntHandle: frame.ntHandle },
        },
        allReferencesReleased: () => this.finishNativeRelease(key),
      })
    } catch (error) {
      this.reportFailure('import', frame, error)
      this.releaseNativeFrame(frame)
      return false
    }
    const entry: Entry = {
      frame,
      imported,
      released: false,
      active: true,
      stallTimer: null,
    }
    this.inFlight.set(key, entry)
    entry.stallTimer = setTimeout(
      () => this.recoverStalledTrack(key, trackKey, entry),
      Math.max(1_000, this.dependencies.stallTimeoutMs ?? 5_000),
    )
    entry.stallTimer.unref?.()
    const rendererEpoch = this.rendererEpoch
    const sendTexture = this.dependencies.sendTexture ??
      sharedTexture.sendSharedTexture.bind(sharedTexture)
    try {
      await sendTexture(
        { frame: window.webContents.mainFrame, importedSharedTexture: imported },
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
      )
      return true
    } catch (error) {
      this.reportFailure('send', frame, error)
      return false
    } finally {
      this.releaseEntryMainReference(key, entry)
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.releaseMainReferences()
    this.latestSequence.clear()
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
      clearTimeout(entry.stallTimer)
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
    if (entry.stallTimer) clearTimeout(entry.stallTimer)
    this.inFlight.delete(key)
    this.releaseNativeFrame(entry.frame)
  }

  private releaseNativeFrame(frame: NativeSharedVideoRelease, attempt = 0) {
    const retry = () => {
      const timer = setTimeout(
        () => this.releaseNativeFrame(frame, attempt + 1),
        Math.min(1_000, 100 * 2 ** Math.min(attempt, 4)),
      )
      timer.unref?.()
    }
    try {
      void Promise.resolve(this.dependencies.release(frame)).catch(retry)
    } catch {
      retry()
    }
  }

  private activeTrackReferences(trackKey: string) {
    const prefix = `${trackKey}:`
    let count = 0
    for (const [key, entry] of this.inFlight) {
      if (entry.active && key.startsWith(prefix)) count += 1
    }
    return count
  }

  private recoverStalledTrack(key: string, trackKey: string, entry: Entry) {
    if (this.disposed || this.inFlight.get(key) !== entry || !entry.active) return
    const prefix = `${trackKey}:`
    for (const [candidateKey, candidate] of this.inFlight) {
      if (!candidate.active || !candidateKey.startsWith(prefix)) continue
      this.retireEntry(candidateKey, candidate)
    }
    console.warn('[native-video] shared texture fence stalled; restarting track', {
      local: entry.frame.local,
      source: entry.frame.source,
      trackId: entry.frame.trackId,
    })
    try {
      void Promise.resolve(this.dependencies.onTrackStalled?.(entry.frame))
        .catch((error) => this.reportFailure('recover', entry.frame, error))
    } catch (error) {
      this.reportFailure('recover', entry.frame, error)
    }
  }

  private reportFailure(
    stage: 'import' | 'send' | 'recover',
    frame: NativeSharedVideoFrame,
    error: unknown,
  ) {
    const now = Date.now()
    if (now - this.lastFailureReportAt < 10_000) return
    this.lastFailureReportAt = now
    console.warn(`[native-video] shared texture ${stage} failed`, {
      local: frame.local,
      source: frame.source,
      trackId: frame.trackId,
      width: frame.width,
      height: frame.height,
      error,
    })
  }
}
