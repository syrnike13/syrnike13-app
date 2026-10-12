import { ipcMain, sharedTexture, type SharedTextureImportedSubtle, type SharedTextureImportTextureInfo, type WebFrameMain } from 'electron'
import { Option, Schema } from 'effect'
import { MEDIA_TEXTURE_ACK, MEDIA_TEXTURE_TRANSFER, MediaTextureAckSchema } from '../../media-texture-contract'

type FrameTarget = Pick<WebFrameMain, 'processId' | 'routingId' | 'isDestroyed' | 'send'>
type Texture = Pick<SharedTextureImportedSubtle, 'startTransferSharedTexture' | 'release'>
export type ElectronFrameTexture = { readonly id: string; release(): void }
export type ReceiverProcessReference = { hasExited(): boolean; close(): void }
export type TextureReleaseStall = 'receiver_release_timeout' | 'gpu_release_timeout'
const RELEASE_DEADLINE_MS = 2_000
type PendingTransfer = { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
type Entry = {
  texture: Texture
  allReleased(): void
  mainReference: boolean
  target: { frame: FrameTarget; processId: number; routingId: number; process: ReceiverProcessReference } | null
  imported: boolean
  receiverReleased: boolean
  finalizing: boolean
  pending: PendingTransfer | null
  releaseDeadline: number | null
  stalled: boolean
  onStall(code: TextureReleaseStall): void
}

/** A timeout ends the request, never the GPU lease. Keep the main texture until
 * the isolated preload confirms GPU release or its exact frame is destroyed. */
export class ElectronFrameTransfers {
  private readonly entries = new Map<string, Entry>()

  constructor(
    private readonly importNative: (info: SharedTextureImportTextureInfo) => Texture = sharedTexture.subtle.importSharedTexture,
  ) {}

  get outstanding() { return this.entries.size }

  metrics() {
    const entries = [...this.entries.values()]
    return {
      retained: entries.length,
      awaitingImport: entries.filter(entry => !entry.imported).length,
      awaitingReceiverRelease: entries.filter(entry => !entry.receiverReleased).length,
      awaitingMainRelease: entries.filter(entry => entry.mainReference).length,
      awaitingGpuRelease: entries.filter(entry => entry.finalizing).length,
    }
  }

  importTexture(
    info: SharedTextureImportTextureInfo,
    allReleased: () => void,
    onStall: (code: TextureReleaseStall) => void = () => undefined,
  ): ElectronFrameTexture {
    if (this.entries.size >= 68) throw new Error('Electron texture capacity exhausted')
    const texture = this.importNative(info)
    const id = crypto.randomUUID()
    this.entries.set(id, {
      texture, allReleased, mainReference: true, target: null, imported: false,
      receiverReleased: true, finalizing: false, pending: null,
      releaseDeadline: null, stalled: false, onStall,
    })
    return { id, release: () => {
      const entry = this.entries.get(id)
      if (!entry) return
      entry.mainReference = false
      this.finalize(id, entry)
    } }
  }

  send(texture: ElectronFrameTexture, frame: FrameTarget, metadata: unknown, receiver: ReceiverProcessReference): Promise<void> {
    const entry = this.entries.get(texture.id)
    if (!entry || entry.target || frame.isDestroyed()) {
      receiver.close()
      return Promise.reject(new Error('Texture target is unavailable'))
    }
    let transfer: ReturnType<Texture['startTransferSharedTexture']>
    try { transfer = entry.texture.startTransferSharedTexture() }
    catch (error) { receiver.close(); return Promise.reject(error) }
    entry.target = { frame, processId: frame.processId, routingId: frame.routingId, process: receiver }
    entry.receiverReleased = false
    entry.releaseDeadline = performance.now() + RELEASE_DEADLINE_MS
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.pending = null
        reject(new Error('Texture import acknowledgement exceeded its deadline'))
      }, 1_000)
      timer.unref?.()
      entry.pending = { resolve, reject, timer }
      try {
        frame.send(MEDIA_TEXTURE_TRANSFER, { id: texture.id, transfer, metadata })
      } catch {
        this.finishPending(entry, false)
        // A failed send is uncertain until the frame is destroyed. Retention is
        // bounded globally, including across account and utility replacements.
      }
    })
  }

  acknowledge(frame: FrameTarget | null, id: string, phase: 'imported' | 'released') {
    const entry = this.entries.get(id)
    if (!entry || !frame || !entry.target || entry.finalizing ||
        frame.processId !== entry.target.processId || frame.routingId !== entry.target.routingId) return
    if (phase === 'imported') {
      entry.imported = true
      this.finishPending(entry, true)
    } else {
      entry.receiverReleased = true
      this.finishPending(entry, entry.imported)
      this.finalize(id, entry)
    }
  }

  sweep() {
    const now = performance.now()
    for (const [id, entry] of this.entries) {
      // The retained kernel object also covers a crash whose frame wrapper is
      // reused by Chromium. This ends only the receiver reference; native reuse
      // still waits for the final GPU release callback below.
      if (entry.target && (entry.target.frame.isDestroyed() || entry.target.process.hasExited())) {
        entry.receiverReleased = true
        this.finishPending(entry, false)
        this.finalize(id, entry)
      }
      if (!this.entries.has(id) || entry.stalled || entry.releaseDeadline === null || now < entry.releaseDeadline) continue
      if (!entry.receiverReleased || entry.finalizing) {
        entry.stalled = true
        entry.onStall(entry.finalizing ? 'gpu_release_timeout' : 'receiver_release_timeout')
      }
    }
  }

  private finishPending(entry: Entry, success: boolean) {
    const pending = entry.pending
    entry.pending = null
    if (!pending) return
    clearTimeout(pending.timer)
    if (success) pending.resolve()
    else pending.reject(new Error('Texture transfer ended before presentation'))
  }

  private finalize(id: string, entry: Entry) {
    if (entry.mainReference || !entry.receiverReleased || entry.finalizing) return
    entry.finalizing = true
    entry.releaseDeadline = performance.now() + RELEASE_DEADLINE_MS
    entry.texture.release(() => {
      if (this.entries.get(id) !== entry) return
      this.entries.delete(id)
      entry.target?.process.close()
      entry.allReleased()
    })
  }
}

let sharedTransfers: ElectronFrameTransfers | null = null
export function electronFrameTransfers() {
  if (sharedTransfers) return sharedTransfers
  const transfers = new ElectronFrameTransfers()
  sharedTransfers = transfers
  ipcMain.on(MEDIA_TEXTURE_ACK, (event, raw: unknown) => {
    const ack = Schema.decodeUnknownOption(MediaTextureAckSchema)(raw)
    if (Option.isSome(ack)) transfers.acknowledge(event.senderFrame, ack.value.id, ack.value.phase)
  })
  const timer = setInterval(() => transfers.sweep(), 250)
  timer.unref?.()
  return transfers
}
