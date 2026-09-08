import { createRequire } from 'node:module'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { Option, Schema } from 'effect'

import {
  MediaExportedFrameSchema,
  type MediaExportedFrame,
  type MediaFrameRelease,
  type MediaInventory,
  type MediaEngineSnapshot,
} from './contract'
import type { MediaRuntimeSupervisor } from './media-runtime-supervisor'
import type { NativeRtcEngineAdapterV2 } from '../voice/native-rtc-engine-adapter-v2'
import { TextureLeaseBridge } from './texture-lease-bridge'
import { resolveMediaUtilityPaths } from './media-utility-adapter'
import { electronFrameTransfers, type ElectronFrameTexture } from './electron-frame-transfers'

type Broker = {
  openProducer(pid: number): unknown
  closeProducer(producer: unknown): void
  duplicate(producer: unknown, handle: number): Buffer
  closeHandle(handle: Buffer): void
}
const BrokerSchema = Schema.declare<Broker>((input): input is Broker =>
  typeof input === 'object' && input !== null &&
  ['openProducer', 'closeProducer', 'duplicate', 'closeHandle'].every(key => typeof Reflect.get(input, key) === 'function'))
type Bridge = TextureLeaseBridge<MediaExportedFrame, ImportedSharedTexture>
type ImportedSharedTexture = ElectronFrameTexture
type Publication = MediaInventory['video']['publications'][number]
type Renderer = { id: string; epoch: number }
type PresentationPath = 'screen_preview' | 'camera_preview' | 'remote_video'
type PresentationFailure = {
  path: PresentationPath; publicationId: string; revision: number; rendererId: string; epoch: number; code: string
  stalledLeases: Set<string>
}
type RuntimePort = Pick<MediaRuntimeSupervisor, 'getSnapshot' | 'getHostEpoch' | 'queryInventory' | 'queryFrames'>
type AdapterPort = Pick<NativeRtcEngineAdapterV2,
  'rendererReady' | 'rendererGone' | 'setPreviewDemand' | 'setRemoteVideoDemand' | 'snapshot'>
let nextRendererEpoch = 0
const leaseKey = (lease: MediaFrameRelease) => `${lease.generation}:${lease.sequence}:${lease.slot}`

/** Main owns only Electron texture references and a retained producer-process
 * handle. Capture, SDK ownership and GPU take/release remain in the utility. */
export class MediaFrameController {
  private renderer: Renderer | null = null
  private epoch = 0
  private sessionId = ''
  private broker: Broker | null = null
  private producer: unknown = null
  private brokerFailed = false
  private readonly presentationFailures = new Map<string, PresentationFailure>()
  private readonly bridges = new Map<string, Bridge>()
  private readonly retired = new Set<Bridge>()
  private readonly releases = new Map<string, MediaFrameRelease>()
  private publications: ReadonlyArray<Publication> = []
  private demanded = new Set<string>()
  private screenPreview = false
  private framePending = false
  private inventoryPending = false
  private lastInventoryAt = 0
  private disposed = false
  private readonly timer: ReturnType<typeof setInterval>

  constructor(
    private readonly runtime: RuntimePort,
    private readonly adapter: AdapterPort,
    private readonly getWindow: () => BrowserWindow | null,
    private readonly reportFailure: (code: string) => void,
    private readonly onInventory: (inventory: MediaInventory) => void = () => undefined,
    private readonly onPresentationChange: () => void = () => undefined,
  ) {
    this.timer = setInterval(() => {
      void this.poll().catch(() => this.reportFailure('video_bridge_query_failed'))
    }, 16)
    this.timer.unref?.()
  }

  rendererReady() {
    if (this.disposed) return
    if (!this.renderer) {
      this.brokerFailed = false
      this.renderer = { id: crypto.randomUUID(), epoch: ++nextRendererEpoch }
      this.adapter.rendererReady(this.renderer.id)
      this.adapter.setPreviewDemand(this.renderer.id, this.screenPreview, true)
    }
    for (const publication of this.publications) this.publish('available', publication)
    this.lastInventoryAt = 0
  }
  rendererGone() {
    if (this.renderer) this.adapter.rendererGone(this.renderer.id)
    this.renderer = null
    this.presentationFailures.clear()
    this.demanded.clear()
    this.screenPreview = false
    this.retireBridges()
  }
  setRemoteDemand(sessionId: string, generation: number, publicationId: string, demanded: boolean) {
    if (!this.renderer || sessionId !== this.sessionId || generation !== this.epoch ||
        !this.publications.some(value => value.publicationId === publicationId)) return
    if (demanded) this.demanded.add(publicationId)
    else this.demanded.delete(publicationId)
    this.adapter.setRemoteVideoDemand(this.renderer.id,
      this.publications.filter(value => this.demanded.has(value.publicationId)).map(value => ({
        publicationId: value.publicationId, participantIdentity: value.participantIdentity,
      })))
  }
  setScreenPreview(demanded: boolean) {
    this.screenPreview = demanded
    if (this.renderer) this.adapter.setPreviewDemand(this.renderer.id, demanded, true)
  }
  presentationPaths(): MediaEngineSnapshot['tracks'] {
    const snapshot = this.adapter.snapshot()
    const paths = { ...snapshot.tracks }
    for (const failure of this.presentationFailures.values()) {
      const path = failure.path
      if (failure.epoch !== this.runtime.getHostEpoch() || failure.rendererId !== this.renderer?.id ||
          failure.revision !== snapshot.acceptedRevision || paths[path].state === 'off') continue
      paths[path] = {
        revision: failure.revision, state: 'failed', warning: false,
        failure: { code: failure.code, stage: 'presentation', message: 'Video presentation is unavailable', retryable: false },
      }
    }
    return paths
  }
  metrics() {
    return {
      ...electronFrameTransfers().metrics(),
      queuedNativeReleases: this.releases.size,
      activeLeases: [...this.bridges.values()].reduce((count, bridge) => count + bridge.outstanding, 0),
      retiredLeases: [...this.retired].reduce((count, bridge) => count + bridge.outstanding, 0),
    }
  }
  dispose() {
    this.rendererGone()
    this.disposed = true
    clearInterval(this.timer)
    this.retireEpoch()
  }
  private send(channel: string, metadata: unknown) {
    const window = this.getWindow()
    if (this.renderer && window && !window.isDestroyed()) window.webContents.send(channel, metadata)
  }
  private publish(action: 'available' | 'unavailable', publication: Publication) {
    this.send(`syrnike-desktop:media:remote-video-publication-${action}`, {
      sessionId: this.sessionId, generation: this.epoch, trackId: publication.publicationId,
      participantIdentity: publication.participantIdentity, source: publication.source,
    })
  }
  private retireEpoch() {
    for (const publication of this.publications) this.publish('unavailable', publication)
    // A released lease no longer needs a native acknowledgement after its
    // producer epoch is gone. Retained Electron references still drain normally.
    this.epoch = 0
    this.publications = []
    this.presentationFailures.clear()
    this.demanded.clear()
    this.retireBridges()
    this.releases.clear()
    if (this.producer !== null) this.broker?.closeProducer(this.producer)
    this.producer = null
    this.brokerFailed = false
    this.sessionId = ''
  }
  private retireBridges() {
    for (const bridge of this.bridges.values()) {
      bridge.setReady(false)
      bridge.retryReleases()
      if (bridge.outstanding) this.retired.add(bridge)
    }
    this.bridges.clear()
  }
  private openProducer(pid: number) {
    if (!this.broker) {
      const filename = path.join(path.dirname(resolveMediaUtilityPaths().nativeModulePath), 'windows_media_texture_broker.node')
      const loaded: unknown = createRequire(filename)(filename)
      const decoded = Schema.decodeUnknownOption(BrokerSchema)(loaded)
      if (Option.isNone(decoded)) throw new Error('Invalid texture handle broker')
      this.broker = decoded.value
    }
    this.producer = this.broker.openProducer(pid)
  }
  private async poll() {
    if (this.disposed) return
    for (const bridge of this.retired) if (bridge.outstanding === 0) this.retired.delete(bridge)
    for (const [key, bridge] of this.bridges)
      if (key.startsWith('remote:') && bridge.outstanding === 0 &&
          !this.publications.some(value => key === `remote:${value.publicationId}`)) this.bridges.delete(key)
    const runtime = this.runtime.getSnapshot()
    if (runtime.status !== 'ready' || !runtime.pid) {
      if (this.epoch) this.retireEpoch()
      return
    }
    const epoch = this.runtime.getHostEpoch()
    if (epoch !== this.epoch) {
      this.retireEpoch()
      this.epoch = epoch
      this.lastInventoryAt = 0
    }
    if (this.renderer && !this.inventoryPending && Date.now() - this.lastInventoryAt >= 250) {
      const renderer = this.renderer
      const revision = this.adapter.snapshot().acceptedRevision
      this.inventoryPending = true
      this.lastInventoryAt = Date.now()
      void this.runtime.queryInventory().then(inventory => {
        if (this.disposed || epoch !== this.epoch || epoch !== this.runtime.getHostEpoch() || this.renderer !== renderer) return
        const snapshot = this.adapter.snapshot()
        if (snapshot.acceptedRevision !== revision) return
        this.onInventory(inventory)
        const session = snapshot.roomState === 'connected'
          ? snapshot.desiredState?.room?.credentialLeaseId ?? '' : ''
        if (session !== this.sessionId) {
          for (const publication of this.publications) this.publish('unavailable', publication)
          this.publications = []
          this.demanded.clear()
          this.sessionId = session
        }
        const next = session ? inventory.video.publications : []
        for (const publication of this.publications)
          if (!next.some(value => value.publicationId === publication.publicationId)) {
            this.publish('unavailable', publication)
            this.demanded.delete(publication.publicationId)
          }
        for (const publication of next)
          if (!this.publications.some(value => value.publicationId === publication.publicationId)) this.publish('available', publication)
        this.publications = next
        for (const [key, failure] of this.presentationFailures) {
          if (failure.path === 'remote_video' && !next.some(value => value.publicationId === failure.publicationId))
            this.presentationFailures.delete(key)
        }
      }).catch(() => this.reportFailure('video_inventory_query_failed')).finally(() => { this.inventoryPending = false })
    }
    const paths = this.adapter.snapshot().tracks
    const previewActive = [paths.screen_preview, paths.camera_preview]
      .some(path => path.state === 'running' || path.state === 'starting')
    const frameDemand = this.renderer && (previewActive || this.demanded.size > 0)
    if (this.framePending || (!frameDemand && this.releases.size === 0)) return
    this.framePending = true
    const releases = [...this.releases.values()]
    try {
      const frames = await this.runtime.queryFrames(releases)
      if (epoch !== this.epoch || epoch !== this.runtime.getHostEpoch() || this.disposed) return
      for (const release of releases) {
        this.releases.delete(leaseKey(release))
        for (const bridge of this.bridges.values()) bridge.acknowledgeRelease(release)
        for (const bridge of this.retired) bridge.acknowledgeRelease(release)
      }
      for (const frame of frames) this.offer(frame, epoch)
    } finally { this.framePending = false }
  }
  private offer(frame: MediaExportedFrame, epoch: number) {
    const snapshot = this.adapter.snapshot()
    const local = frame.kind !== 'remote'
    const publication = this.publications.find(value => value.publicationId === frame.publicationId)
    const totalOutstanding = [...this.bridges.values(), ...this.retired].reduce((count, bridge) => count + bridge.outstanding, 0)
    if (!this.renderer || frame.rendererId !== this.renderer.id || frame.revision !== snapshot.acceptedRevision ||
        (!local && !publication) || totalOutstanding >= 68) {
      this.queueRelease(frame)
      return
    }
    if (this.producer === null && !this.brokerFailed) {
      const pid = this.runtime.getSnapshot().pid
      try {
        if (!pid) throw new Error('Media producer is unavailable')
        this.openProducer(pid)
      } catch {
        this.brokerFailed = true
        this.presentationFailed(frame, epoch, 'video_handle_broker_failed')
      }
    }
    if (this.brokerFailed) {
      this.presentationFailed(frame, epoch, 'video_handle_broker_failed')
      this.queueRelease(frame)
      return
    }
    const key = `${frame.kind}:${frame.publicationId}`
    let bridge = this.bridges.get(key)
    if (!bridge) {
      if (this.bridges.size >= 66 || !this.broker || this.producer === null) {
        this.queueRelease(frame)
        this.presentationFailed(frame, epoch, 'video_bridge_capacity')
        return
      }
      const broker = this.broker
      const producer = this.producer
      const transfers = electronFrameTransfers()
      const created = new TextureLeaseBridge<MediaExportedFrame, ImportedSharedTexture>({
        hostEpoch: epoch,
        importTexture: (lease, released) => {
          const handle = broker.duplicate(producer, lease.handle)
          try {
            return transfers.importTexture({
                pixelFormat: 'bgra', codedSize: { width: lease.width, height: lease.height },
                timestamp: lease.timestamp, handle: { ntHandle: handle },
            }, () => {
              broker.closeHandle(handle)
              released()
              this.presentationRecovered(lease, epoch)
            }, code => this.presentationFailed(lease, epoch, `video_bridge_${code}`, true))
          } catch (error) { broker.closeHandle(handle); throw error }
        },
        sendTexture: (texture, metadata) => {
          const window = this.getWindow()
          if (!window || window.isDestroyed() || !this.renderer || metadata.rendererId !== this.renderer.id || epoch !== this.epoch)
            return Promise.resolve()
          return transfers.send(texture, window.webContents.mainFrame, {
            sessionId: this.sessionId || `local-${epoch}`, generation: epoch,
            trackId: metadata.publicationId, participantIdentity: metadata.participantIdentity,
            source: metadata.kind === 'camera_preview' ? 'camera' : metadata.kind === 'screen_preview' ? 'screen' : publication?.source,
            local: metadata.kind !== 'remote', sequence: metadata.sequence,
            rendererEpoch: this.renderer.epoch, runtimeEpoch: epoch,
            nativeCaptureTimestampUs: metadata.timestamp,
          })
        },
        returnLease: lease => {
          if (epoch !== this.epoch || this.disposed) created.acknowledgeRelease(lease)
          else this.queueRelease(lease)
        },
        failure: (code, lease) => {
          if (lease) this.presentationFailed(lease, epoch, `video_bridge_${code}`)
          else this.reportFailure(`video_bridge_${code}`)
        },
      }, value => Option.getOrUndefined(Schema.decodeUnknownOption(MediaExportedFrameSchema, { onExcessProperty: 'error' })(value)), local ? 2 : 4)
      bridge = created
      this.bridges.set(key, bridge)
    }
    bridge.setReady(true)
    void bridge.offer(frame)
  }
  private queueRelease(lease: MediaFrameRelease) {
    this.releases.set(leaseKey(lease), {
      generation: lease.generation, sequence: lease.sequence, slot: lease.slot,
    })
  }
  private presentationFailed(frame: MediaExportedFrame, epoch: number, code: string, stalled = false) {
    if (this.disposed || epoch !== this.runtime.getHostEpoch() || frame.rendererId !== this.renderer?.id ||
        frame.revision !== this.adapter.snapshot().acceptedRevision) return
    const path = frame.kind === 'remote' ? 'remote_video' : frame.kind
    const key = `${frame.kind}:${frame.publicationId}`
    const previous = this.presentationFailures.get(key)
    if (previous?.revision === frame.revision && previous.rendererId === frame.rendererId && previous.epoch === epoch) {
      if (stalled) previous.stalledLeases.add(leaseKey(frame))
      if (previous.code === code || previous.stalledLeases.size > 0) return
    }
    this.presentationFailures.set(key, {
      path, publicationId: frame.publicationId, code, revision: frame.revision, rendererId: frame.rendererId, epoch,
      stalledLeases: new Set(stalled ? [leaseKey(frame)] : []),
    })
    this.reportFailure(code)
    this.onPresentationChange()
  }
  private presentationRecovered(frame: Omit<MediaExportedFrame, 'handle'>, epoch: number) {
    if (this.disposed || epoch !== this.runtime.getHostEpoch() || frame.rendererId !== this.renderer?.id) return
    const key = `${frame.kind}:${frame.publicationId}`
    const failure = this.presentationFailures.get(key)
    if (!failure || failure.revision !== frame.revision || failure.rendererId !== frame.rendererId || failure.epoch !== epoch) return
    failure.stalledLeases.delete(leaseKey(frame))
    if (failure.stalledLeases.size > 0) return
    this.presentationFailures.delete(key)
    this.onPresentationChange()
  }
}
