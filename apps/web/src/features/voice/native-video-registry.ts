export type NativeVideoSource = 'camera' | 'screen'

export type NativeVideoTrackMetadata = {
  sessionId: string
  generation: number
  trackId: string
  participantIdentity: string
  source: NativeVideoSource
  local: boolean
  sequence: number
  rendererEpoch: number
}

type NativeVideoFrameMessage = {
  type: 'syrnike-native-video-frame'
  metadata: NativeVideoTrackMetadata
  frame: VideoFrame
}

type CanvasConsumer = {
  canvas: HTMLCanvasElement
  context: CanvasRenderingContext2D
  onSizeChange?: (size: { width: number; height: number }) => void
  width: number
  height: number
}

type TrackEntry = {
  metadata: NativeVideoTrackMetadata
  adapter: NativeVideoTrackAdapter
  consumers: Map<symbol, CanvasConsumer>
  pendingFrame: VideoFrame | null
  drawRequest: number | null
}

const LOCAL_SCREEN_PREVIEW_TRACK_ID = 'local-screen-preview'

export type NativeVideoRegistryTrack = NativeVideoTrackMetadata & {
  track: NativeVideoTrackAdapter
  consumerCount: number
}

export class NativeVideoTrackAdapter {
  readonly kind = 'video'

  constructor(
    readonly sid: string,
    private readonly registry: NativeVideoRegistry,
  ) {}

  attachCanvas(
    canvas: HTMLCanvasElement,
    onSizeChange?: (size: { width: number; height: number }) => void,
  ) {
    return this.registry.attachCanvas(this.sid, canvas, onSizeChange)
  }
}

export function isNativeVideoTrackAdapter(
  track: unknown,
): track is NativeVideoTrackAdapter {
  return track instanceof NativeVideoTrackAdapter
}

export class NativeVideoRegistry {
  private readonly tracks = new Map<string, TrackEntry>()
  private readonly localScreenConsumers = new Map<symbol, CanvasConsumer>()
  private readonly localScreenAdapter = new NativeVideoTrackAdapter(
    LOCAL_SCREEN_PREVIEW_TRACK_ID,
    this,
  )
  private readonly tombstones = new Map<
    string,
    { sessionId: string; generation: number }
  >()
  private readonly listeners = new Set<() => void>()
  private listening = false
  private version = 0

  start() {
    if (this.listening || typeof window === 'undefined') return
    this.listening = true
    window.addEventListener('message', this.onMessage)
  }

  stop() {
    if (!this.listening || typeof window === 'undefined') return
    this.listening = false
    window.removeEventListener('message', this.onMessage)
    for (const [trackId, entry] of this.tracks) {
      this.disposeTrack(trackId, entry, false)
    }
    this.localScreenConsumers.clear()
    this.tombstones.clear()
    this.notify()
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getTrack(trackId: string): NativeVideoTrackAdapter | null {
    return this.tracks.get(trackId)?.adapter ?? null
  }

  getMetadata(trackId: string) {
    return this.tracks.get(trackId)?.metadata ?? null
  }

  getSnapshot = () => this.version

  getLocalScreenPreviewTrack() {
    return this.localScreenAdapter
  }

  getLocalScreenPreviewConsumerCount() {
    return this.localScreenConsumers.size
  }

  listTracks(): NativeVideoRegistryTrack[] {
    return [...this.tracks.values()].map((entry) => ({
      ...entry.metadata,
      track: entry.adapter,
      consumerCount: this.consumersFor(entry).size,
    }))
  }

  attachCanvas(
    trackId: string,
    canvas: HTMLCanvasElement,
    onSizeChange?: (size: { width: number; height: number }) => void,
  ) {
    const entry = this.tracks.get(trackId)
    const consumers = trackId === LOCAL_SCREEN_PREVIEW_TRACK_ID
      ? this.localScreenConsumers
      : entry
        ? this.consumersFor(entry)
        : null
    if (!consumers) return () => undefined
    const context = canvas.getContext('2d')
    if (!context) return () => undefined

    const token = Symbol(trackId)
    consumers.set(token, {
      canvas,
      context,
      onSizeChange,
      width: 0,
      height: 0,
    })
    this.notify()

    let attached = true
    return () => {
      if (!attached) return
      attached = false
      if (
        consumers !== this.localScreenConsumers &&
        entry &&
        this.tracks.get(trackId) !== entry
      ) {
        return
      }
      if (!consumers.delete(token)) return
      this.notify()
    }
  }

  removeTrack(
    trackId: string,
    expected?: { sessionId: string; generation: number },
  ) {
    const entry = this.tracks.get(trackId)
    if (!entry) return
    if (
      expected &&
      (entry.metadata.sessionId !== expected.sessionId ||
        entry.metadata.generation !== expected.generation)
    ) {
      return
    }
    this.disposeTrack(trackId, entry)
  }

  private readonly onMessage = (event: MessageEvent<unknown>) => {
    if (event.source !== window || event.origin !== window.location.origin) return
    if (isTrackRemovedMessage(event.data)) {
      this.tombstones.set(event.data.metadata.trackId, event.data.metadata)
      this.removeTrack(event.data.metadata.trackId, event.data.metadata)
      return
    }
    if (!isFrameMessage(event.data)) return
    const { metadata, frame } = event.data
    const tombstone = this.tombstones.get(metadata.trackId)
    if (tombstone) {
      if (
        tombstone.sessionId === metadata.sessionId &&
        metadata.generation <= tombstone.generation
      ) {
        frame.close()
        return
      }
      this.tombstones.delete(metadata.trackId)
    }

    let entry = this.tracks.get(metadata.trackId)
    if (
      entry &&
      (metadata.rendererEpoch !== entry.metadata.rendererEpoch ||
        metadata.generation !== entry.metadata.generation)
    ) {
      this.removeTrack(metadata.trackId)
      entry = undefined
    }
    if (entry && metadata.sequence <= entry.metadata.sequence) {
      frame.close()
      return
    }

    if (!entry) {
      entry = {
        metadata,
        adapter: new NativeVideoTrackAdapter(metadata.trackId, this),
        consumers: new Map(),
        pendingFrame: null,
        drawRequest: null,
      }
      this.tracks.set(metadata.trackId, entry)
      this.notify()
    } else {
      entry.metadata = metadata
    }

    const consumers = this.consumersFor(entry)
    if (consumers.size === 0) {
      frame.close()
      return
    }
    entry.pendingFrame?.close()
    entry.pendingFrame = frame
    if (entry.drawRequest !== null) return
    try {
      entry.drawRequest = window.requestAnimationFrame(() => {
        this.drawPendingFrame(metadata.trackId, entry)
      })
    } catch {
      entry.pendingFrame = null
      frame.close()
    }
  }

  private drawPendingFrame(trackId: string, entry: TrackEntry) {
    entry.drawRequest = null
    const frame = entry.pendingFrame
    entry.pendingFrame = null
    if (!frame) return
    try {
      if (this.tracks.get(trackId) !== entry) return
      for (const consumer of this.consumersFor(entry).values()) {
        try {
          drawFrame(consumer, frame)
        } catch {
          // A detached or context-lost canvas must not retain the shared frame.
        }
      }
    } finally {
      frame.close()
    }
  }

  private disposeTrack(
    trackId: string,
    entry: TrackEntry,
    shouldNotify = true,
  ) {
    if (this.tracks.get(trackId) !== entry) return
    this.tracks.delete(trackId)
    entry.pendingFrame?.close()
    entry.pendingFrame = null
    if (entry.drawRequest !== null) {
      window.cancelAnimationFrame(entry.drawRequest)
      entry.drawRequest = null
    }
    entry.consumers.clear()
    if (shouldNotify) this.notify()
  }

  private consumersFor(entry: TrackEntry) {
    return entry.metadata.local && entry.metadata.source === 'screen'
      ? this.localScreenConsumers
      : entry.consumers
  }

  private notify() {
    this.version += 1
    for (const listener of this.listeners) listener()
  }
}

function drawFrame(consumer: CanvasConsumer, frame: VideoFrame) {
  const width = frame.displayWidth || frame.codedWidth
  const height = frame.displayHeight || frame.codedHeight
  if (width <= 0 || height <= 0) return

  if (consumer.width !== width || consumer.height !== height) {
    consumer.width = width
    consumer.height = height
    consumer.canvas.width = width
    consumer.canvas.height = height
    consumer.onSizeChange?.({ width, height })
  }
  consumer.context.drawImage(frame, 0, 0, width, height)
}

function isTrackRemovedMessage(value: unknown): value is {
  type: 'syrnike-native-video-track-removed'
  metadata: { trackId: string; sessionId: string; generation: number }
} {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { type?: unknown; metadata?: { trackId?: unknown } }
  return (
    candidate.type === 'syrnike-native-video-track-removed' &&
    typeof candidate.metadata?.trackId === 'string' &&
    typeof (candidate.metadata as { sessionId?: unknown }).sessionId ===
      'string' &&
    Number.isSafeInteger(
      (candidate.metadata as { generation?: unknown }).generation,
    )
  )
}

function isFrameMessage(value: unknown): value is NativeVideoFrameMessage {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<NativeVideoFrameMessage>
  const metadata = candidate.metadata as
    | Partial<NativeVideoTrackMetadata>
    | undefined
  return (
    candidate.type === 'syrnike-native-video-frame' &&
    candidate.frame instanceof VideoFrame &&
    Boolean(metadata) &&
    typeof metadata?.trackId === 'string' &&
    typeof metadata.sessionId === 'string' &&
    typeof metadata.participantIdentity === 'string' &&
    (metadata.source === 'camera' || metadata.source === 'screen') &&
    typeof metadata.local === 'boolean' &&
    Number.isSafeInteger(metadata.generation) &&
    Number.isSafeInteger(metadata.sequence) &&
    Number.isSafeInteger(metadata.rendererEpoch)
  )
}

export const nativeVideoRegistry = new NativeVideoRegistry()
