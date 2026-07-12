export type NativeVideoSource = 'camera' | 'screen'

export type NativeVideoTrackMetadata = {
  sessionId: string
  generation: number
  trackId: string
  participantIdentity: string
  source: NativeVideoSource
  sequence: number
  rendererEpoch: number
}

type NativeVideoFrameMessage = {
  type: 'syrnike-native-video-frame'
  metadata: NativeVideoTrackMetadata
  frame: VideoFrame
}

type TrackEntry = {
  metadata: NativeVideoTrackMetadata
  generator: MediaStreamTrack & { writable: WritableStream<VideoFrame> }
  writer: WritableStreamDefaultWriter<VideoFrame>
}

export type NativeVideoRegistryTrack = NativeVideoTrackMetadata & {
  track: NativeVideoTrackAdapter
}

export class NativeVideoTrackAdapter {
  readonly kind = 'video'
  constructor(readonly sid: string, readonly mediaStreamTrack: MediaStreamTrack) {}

  attach(element?: HTMLMediaElement) {
    const target = element ?? document.createElement('video')
    target.srcObject = new MediaStream([this.mediaStreamTrack])
    return target
  }

  detach(element?: HTMLMediaElement) {
    if (element) {
      element.srcObject = null
      return element
    }
    return []
  }
}

export class NativeVideoRegistry {
  private readonly tracks = new Map<string, TrackEntry>()
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
    for (const entry of this.tracks.values()) {
      void entry.writer.abort()
      entry.generator.stop()
    }
    this.tracks.clear()
    this.notify()
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getTrack(trackId: string): MediaStreamTrack | null {
    return this.tracks.get(trackId)?.generator ?? null
  }

  getMetadata(trackId: string) {
    return this.tracks.get(trackId)?.metadata ?? null
  }

  getSnapshot = () => this.version

  listTracks(): NativeVideoRegistryTrack[] {
    return [...this.tracks.values()].map((entry) => ({
      ...entry.metadata,
      track: new NativeVideoTrackAdapter(entry.metadata.trackId, entry.generator),
    }))
  }

  removeTrack(trackId: string) {
    const entry = this.tracks.get(trackId)
    if (!entry) return
    this.tracks.delete(trackId)
    void entry.writer.abort()
    entry.generator.stop()
    this.notify()
  }

  private readonly onMessage = (event: MessageEvent<unknown>) => {
    if (event.source !== window || event.origin !== window.location.origin) return
    if (isTrackRemovedMessage(event.data)) {
      this.removeTrack(event.data.metadata.trackId)
      return
    }
    if (!isFrameMessage(event.data)) return
    const { metadata, frame } = event.data
    let entry = this.tracks.get(metadata.trackId)
    if (entry && (metadata.rendererEpoch !== entry.metadata.rendererEpoch || metadata.generation !== entry.metadata.generation)) {
      this.removeTrack(metadata.trackId)
      entry = undefined
    }
    if (entry && metadata.sequence <= entry.metadata.sequence) {
      frame.close()
      return
    }
    if (!entry) {
      const Generator = (globalThis as typeof globalThis & {
        MediaStreamTrackGenerator: new (options: { kind: 'video' }) =>
          MediaStreamTrack & { writable: WritableStream<VideoFrame> }
      }).MediaStreamTrackGenerator
      const generator = new Generator({ kind: 'video' })
      entry = { metadata, generator, writer: generator.writable.getWriter() }
      this.tracks.set(metadata.trackId, entry)
      this.notify()
    } else {
      entry.metadata = metadata
    }
    void entry.writer.write(frame).catch(() => this.removeTrack(metadata.trackId)).finally(() => frame.close())
  }

  private notify() {
    this.version += 1
    for (const listener of this.listeners) listener()
  }
}

function isTrackRemovedMessage(value: unknown): value is {
  type: 'syrnike-native-video-track-removed'
  metadata: { trackId: string }
} {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { type?: unknown; metadata?: { trackId?: unknown } }
  return candidate.type === 'syrnike-native-video-track-removed' &&
    typeof candidate.metadata?.trackId === 'string'
}

function isFrameMessage(value: unknown): value is NativeVideoFrameMessage {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<NativeVideoFrameMessage>
  const metadata = candidate.metadata as Partial<NativeVideoTrackMetadata> | undefined
  return candidate.type === 'syrnike-native-video-frame' && candidate.frame instanceof VideoFrame &&
    Boolean(metadata) && typeof metadata?.trackId === 'string' &&
    typeof metadata.sessionId === 'string' && typeof metadata.participantIdentity === 'string' &&
    (metadata.source === 'camera' || metadata.source === 'screen') &&
    Number.isSafeInteger(metadata.generation) && Number.isSafeInteger(metadata.sequence) &&
    Number.isSafeInteger(metadata.rendererEpoch)
}

export const nativeVideoRegistry = new NativeVideoRegistry()
