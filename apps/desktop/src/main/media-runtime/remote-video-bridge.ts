import { Option, Schema } from 'effect'

const integer = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const positive = integer.check(Schema.isGreaterThan(0))
export class NativeVideoFrame extends Schema.Class<NativeVideoFrame>('NativeVideoFrame')({
  version: Schema.Literal(1),
  generation: positive,
  sequence: positive,
  slot: integer.check(Schema.isLessThan(4)),
  width: positive.check(Schema.isLessThanOrEqualTo(3840)),
  height: positive.check(Schema.isLessThanOrEqualTo(2160)),
  timestamp: integer,
  ingressUs: integer,
  publicationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  participantIdentity: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  handle: positive,
}) {}

export type VideoLeaseKey = Pick<NativeVideoFrame, 'generation' | 'sequence' | 'slot'>
export type RendererVideoFrame = Omit<NativeVideoFrame, 'handle'> & { readonly hostEpoch: number }
interface TextureReference { release(): void }
interface BridgeDriver<Texture extends TextureReference> {
  readonly hostEpoch: number
  importTexture(lease: NativeVideoFrame, allReferencesReleased: () => void): Texture
  sendTexture(texture: Texture, metadata: RendererVideoFrame): Promise<void>
  // A reliable control operation. Keep retrying until acknowledgeRelease,
  // not merely until the IPC write returns. Driver is bound to one utility epoch.
  returnLease(lease: VideoLeaseKey): void
  failure(code: 'invalid-frame' | 'lease-capacity' | 'texture-transfer' | 'release-channel'): void
}
interface Entry {
  readonly lease: NativeVideoFrame
  referencesReleased: boolean
}
const keyOf = (lease: VideoLeaseKey) => `${lease.generation}:${lease.sequence}:${lease.slot}`

/** Main owns the bridge, native owns slots, Electron owns GPU reference safety. */
export class RemoteVideoBridge<Texture extends TextureReference> {
  private readonly entries = new Map<string, Entry>()
  private generation = 0
  private ready = false

  constructor(private readonly driver: BridgeDriver<Texture>) {}

  setReady(ready: boolean) { this.ready = ready }
  setGeneration(generation: number) {
    if (Number.isSafeInteger(generation) && generation > this.generation) this.generation = generation
  }
  get outstanding() { return this.entries.size }

  async offer(value: unknown): Promise<void> {
    const decoded = Schema.decodeUnknownOption(NativeVideoFrame, { onExcessProperty: 'error' })(value)
    if (Option.isNone(decoded)) { this.driver.failure('invalid-frame'); return }
    const lease = decoded.value
    const key = keyOf(lease)
    // Duplicate delivery must not release or import the already owned slot.
    if (this.entries.has(key)) return
    if (this.entries.size >= 4) { this.driver.failure('lease-capacity'); return }
    const entry: Entry = { lease, referencesReleased: false }
    this.entries.set(key, entry)
    const released = () => {
      if (this.entries.get(key) !== entry || entry.referencesReleased) return
      entry.referencesReleased = true
      this.sendRelease(entry)
    }
    if (!this.ready || lease.generation < this.generation) { released(); return }
    this.setGeneration(lease.generation)
    let texture: Texture | undefined
    try {
      texture = this.driver.importTexture(lease, released)
      const { handle: _handle, ...metadata } = lease
      await this.driver.sendTexture(texture, { ...metadata, hostEpoch: this.driver.hostEpoch })
    } catch {
      // A transfer timeout is not a release. Uncertain imports stay quarantined
      // in the same four-entry bound until Electron proves safety or epoch exit.
      this.driver.failure('texture-transfer')
    } finally {
      texture?.release()
    }
  }

  retryReleases() {
    for (const entry of this.entries.values()) {
      if (!entry.referencesReleased) continue
      this.sendRelease(entry)
    }
  }

  private sendRelease(entry: Entry) {
    try { this.driver.returnLease(entry.lease) }
    catch { this.driver.failure('release-channel') }
  }

  acknowledgeRelease(lease: VideoLeaseKey): boolean {
    const key = keyOf(lease)
    const entry = this.entries.get(key)
    if (!entry?.referencesReleased) return false
    this.entries.delete(key)
    return true
  }
}
