import { setTimeout as delay } from 'node:timers/promises'
import { nativeImage } from 'electron'
import {
  IPC,
  type DesktopDisplayMediaRequest,
  type DesktopDisplayMediaSource,
  type DesktopDisplayMediaSourcePage,
} from '@syrnike13/platform'

import { MEDIA_LIFECYCLE_PROTOCOL_LIMITS } from './protocol.generated'
import type { MediaRuntimeSupervisor } from './media-runtime-supervisor'

const PAGE_SIZE = 24
const MAX_DATA_URL_BYTES = 320_000
type RuntimePort = Pick<MediaRuntimeSupervisor,
  'getHostEpoch' | 'getSnapshot' | 'querySources' | 'queryInventory' | 'queryThumbnail'> & {
  start(): Promise<unknown>
}
type PickerWindow = {
  isDestroyed(): boolean
  webContents: { send(channel: string, payload: unknown): void }
}
type Picker = {
  request: DesktopDisplayMediaRequest
  epoch: number | null
  sources: ReadonlyArray<DesktopDisplayMediaSource>
  page: number
  pageRevision: number
  sourceQuery: Promise<void> | null
  timeout: ReturnType<typeof setTimeout>
}
type ThumbnailJob = {
  picker: Picker
  pageRevision: number
  source: DesktopDisplayMediaSource
  resolve(value: DesktopDisplayMediaSource | null): void
}

/** One native job at a time. At most one visible page waits in main; replacing
 * the request/page cancels its queue and supersedes the native request slot. */
export class NativeScreenPicker {
  private picker: Picker | null = null
  private sourceRevision = 0
  private thumbnailRevision = 0
  private queue: ThumbnailJob[] = []
  private pumping = false
  private disposed = false
  private readonly pending = new Map<string, Promise<DesktopDisplayMediaSource | null>>()

  constructor(
    private readonly runtime: RuntimePort,
    private readonly getWindow: () => PickerWindow | null,
  ) {}

  open(audioRequested: boolean): DesktopDisplayMediaRequest {
    if (this.disposed) throw new Error('Screen picker has stopped')
    this.cancel()
    const request = { id: crypto.randomUUID(), audioRequested, nativeVideo: true }
    const timeout = setTimeout(() => this.cancel(request.id), 120_000)
    timeout.unref?.()
    this.picker = { request, epoch: null, sources: [], page: 0, pageRevision: 0, sourceQuery: null, timeout }
    this.send(IPC.mediaRequest, request)
    return request
  }

  async sources(requestId: string, page: number): Promise<DesktopDisplayMediaSourcePage> {
    const picker = this.picker
    const empty = { sources: [], page, hasPrevious: false, hasNext: false }
    if (!picker || picker.request.id !== requestId || this.disposed) return empty
    if (!picker.sourceQuery) picker.sourceQuery = this.loadSources(picker)
    await picker.sourceQuery
    if (!this.current(picker)) return empty
    const boundedPage = Math.min(page, Math.max(0, Math.ceil(picker.sources.length / PAGE_SIZE) - 1))
    if (boundedPage !== picker.page) {
      picker.page = boundedPage
      ++picker.pageRevision
      this.cancelThumbnails()
    }
    const offset = boundedPage * PAGE_SIZE
    return {
      sources: picker.sources.slice(offset, offset + PAGE_SIZE), page: boundedPage,
      hasPrevious: boundedPage > 0, hasNext: offset + PAGE_SIZE < picker.sources.length,
    }
  }

  visual(requestId: string, sourceId: string): Promise<DesktopDisplayMediaSource | null> {
    const picker = this.picker
    if (!picker || picker.request.id !== requestId || !this.current(picker)) return Promise.resolve(null)
    const source = picker.sources.slice(picker.page * PAGE_SIZE, (picker.page + 1) * PAGE_SIZE)
      .find(value => value.id === sourceId)
    if (!source) return Promise.resolve(null)
    const key = `${requestId}:${picker.pageRevision}:${sourceId}`
    const pending = this.pending.get(key)
    if (pending) return pending
    if (this.pending.size >= PAGE_SIZE) return Promise.resolve(null)
    const promise = new Promise<DesktopDisplayMediaSource | null>(resolve => {
      this.queue.push({ picker, pageRevision: picker.pageRevision, source, resolve })
    })
    this.pending.set(key, promise)
    void promise.finally(() => { if (this.pending.get(key) === promise) this.pending.delete(key) })
    void this.pump()
    return promise
  }

  select(requestId: string, sourceId: string, audioRequested?: boolean): boolean {
    const picker = this.picker
    if (!picker || picker.request.id !== requestId || !this.current(picker)) return false
    const source = picker.sources.find(value => value.id === sourceId)
    if (!source) return false
    const selection = {
      requestId, sourceId,
      audioRequested: (audioRequested ?? picker.request.audioRequested) && source.audioAvailable !== false,
      audioMode: source.type === 'window' ? 'process' : 'system',
    }
    this.cancel(requestId)
    this.send(IPC.mediaDisplayPickerResolved, selection)
    return true
  }

  cancel(requestId?: string) {
    if (requestId && this.picker?.request.id !== requestId) return
    if (this.picker) clearTimeout(this.picker.timeout)
    this.picker = null
    this.cancelThumbnails()
  }
  dispose() { this.cancel(); this.disposed = true }

  private current(picker: Picker) {
    return !this.disposed && this.picker === picker &&
      (picker.epoch === null || picker.epoch === this.runtime.getHostEpoch())
  }
  private send(channel: string, payload: unknown) {
    const window = this.getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
  }
  private cancelThumbnails() {
    for (const job of this.queue) job.resolve(null)
    this.queue = []
    this.pending.clear()
    const revision = ++this.thumbnailRevision
    if (this.runtime.getSnapshot().status === 'ready')
      void this.runtime.queryThumbnail({ revision, sourceId: null }).catch(() => undefined)
  }
  private async loadSources(picker: Picker) {
    await this.runtime.start()
    if (!this.current(picker)) return
    picker.epoch = this.runtime.getHostEpoch()
    const revision = ++this.sourceRevision
    await this.runtime.querySources({ revision, kind: 'all' })
    const deadline = Date.now() + 2_000
    while (this.current(picker) && Date.now() < deadline) {
      const inventory = await this.runtime.queryInventory()
      if (!this.current(picker)) return
      // Native publishes the revision only after enumeration returns. Complete
      // describes catalog coverage; a bounded, truncated result is still ready.
      if (inventory.sources.revision === revision) {
        if (!inventory.sources.ok) throw new Error('Screen sources could not be enumerated')
        picker.sources = inventory.sources.entries.filter(source => source.available).map(source => ({
          id: source.id, name: source.title || source.label,
          type: source.kind === 'monitor' ? 'screen' : 'window',
          thumbnailDataUrl: null, appIconDataUrl: null,
          audioAvailable: source.audioAvailable, audioMode: source.kind === 'monitor' ? 'system_exclude' : 'process',
        }))
        return
      }
      await delay(25)
    }
    if (this.current(picker)) throw new Error('Screen source enumeration deadline exceeded')
  }
  private async pump() {
    if (this.pumping) return
    this.pumping = true
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) {
        let result: DesktopDisplayMediaSource | null = null
        try { result = await this.thumbnail(job) } catch { /* Optional thumbnail failure leaves metadata selectable. */ }
        job.resolve(result)
      }
    } finally { this.pumping = false }
  }
  private async thumbnail(job: ThumbnailJob): Promise<DesktopDisplayMediaSource | null> {
    const current = () => this.current(job.picker) && job.picker.pageRevision === job.pageRevision
    if (!current()) return null
    const revision = ++this.thumbnailRevision
    const deadline = Date.now() + MEDIA_LIFECYCLE_PROTOCOL_LIMITS.thumbnailDeadlineMs
    while (current() && Date.now() < deadline) {
      const thumbnail = await this.runtime.queryThumbnail({ revision, sourceId: job.source.id })
      if (!current() || thumbnail.revision !== revision) return null
      if (thumbnail.state === 'ready' && thumbnail.pixels) {
        const dataUrl = nativeImage.createFromBitmap(Buffer.from(thumbnail.pixels), {
          width: MEDIA_LIFECYCLE_PROTOCOL_LIMITS.thumbnailWidth,
          height: MEDIA_LIFECYCLE_PROTOCOL_LIMITS.thumbnailHeight,
        }).toDataURL()
        return dataUrl.length <= MAX_DATA_URL_BYTES ? { ...job.source, thumbnailDataUrl: dataUrl } : null
      }
      if (thumbnail.state !== 'pending') return null
      await delay(25)
    }
    return null
  }
}
