import { ipcMain, sharedTexture, type SharedTextureImportedSubtle, type SharedTextureImportTextureInfo, type WebFrameMain } from 'electron'
import { Option, Schema } from 'effect'
import { MEDIA_TEXTURE_ACK, MEDIA_TEXTURE_TRANSFER, MediaTextureAckSchema } from '../../media-texture-contract'

type FrameTarget = Pick<WebFrameMain, 'processId' | 'routingId' | 'isDestroyed' | 'send'>
type Texture = Pick<SharedTextureImportedSubtle, 'startTransferSharedTexture' | 'release'>
export type ElectronFrameTexture = { readonly id: string; release(): void }
type PendingTransfer = { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
type Entry = {
  texture: Texture
  allReleased(): void
  mainReference: boolean
  frame: FrameTarget | null
  imported: boolean
  receiverReleased: boolean
  finalizing: boolean
  pending: PendingTransfer | null
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

  importTexture(info: SharedTextureImportTextureInfo, allReleased: () => void): ElectronFrameTexture {
    if (this.entries.size >= 68) throw new Error('Electron texture capacity exhausted')
    const texture = this.importNative(info)
    const id = crypto.randomUUID()
    this.entries.set(id, {
      texture, allReleased, mainReference: true, frame: null, imported: false,
      receiverReleased: true, finalizing: false, pending: null,
    })
    return { id, release: () => {
      const entry = this.entries.get(id)
      if (!entry) return
      entry.mainReference = false
      this.finalize(id, entry)
    } }
  }

  send(texture: ElectronFrameTexture, frame: FrameTarget, metadata: unknown): Promise<void> {
    const entry = this.entries.get(texture.id)
    if (!entry || entry.frame || frame.isDestroyed()) return Promise.reject(new Error('Texture target is unavailable'))
    const transfer = entry.texture.startTransferSharedTexture()
    entry.frame = frame
    entry.receiverReleased = false
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
    if (!entry || !frame || !entry.frame || entry.finalizing ||
        frame.processId !== entry.frame.processId || frame.routingId !== entry.frame.routingId) return
    if (phase === 'imported') {
      entry.imported = true
      this.finishPending(entry, true)
    } else {
      entry.receiverReleased = true
      this.finishPending(entry, entry.imported)
      this.finalize(id, entry)
    }
  }

  sweepDestroyedFrames() {
    for (const [id, entry] of this.entries) {
      if (!entry.frame?.isDestroyed()) continue
      entry.receiverReleased = true
      this.finishPending(entry, false)
      this.finalize(id, entry)
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
    entry.texture.release(() => {
      this.entries.delete(id)
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
  const timer = setInterval(() => transfers.sweepDestroyedFrames(), 250)
  timer.unref?.()
  return transfers
}
