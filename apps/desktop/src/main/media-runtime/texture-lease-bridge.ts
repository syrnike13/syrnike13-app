export interface TextureLeaseKey {
  readonly generation: number
  readonly sequence: number
  readonly slot: number
}
export interface NativeTextureLease extends TextureLeaseKey { readonly handle: number }
export interface TextureReference { release(): void }
export interface TextureBridgeDriver<Lease extends NativeTextureLease, Texture extends TextureReference> {
  readonly hostEpoch: number
  importTexture(lease: Lease, allReferencesReleased: () => void): Texture
  sendTexture(texture: Texture, metadata: Omit<Lease, 'handle'> & { readonly hostEpoch: number }): Promise<void>
  returnLease(lease: TextureLeaseKey): void
  failure(code: 'invalid-frame' | 'lease-capacity' | 'texture-transfer' | 'release-channel'): void
}
interface Entry<Lease> { readonly lease: Lease; referencesReleased: boolean }
const keyOf = (lease: TextureLeaseKey) => `${lease.generation}:${lease.sequence}:${lease.slot}`

/** Each consumer has its own instance, schema, generation and resource bound. */
export class TextureLeaseBridge<Lease extends NativeTextureLease, Texture extends TextureReference> {
  private readonly entries = new Map<string, Entry<Lease>>()
  private generation = 0
  private ready = false
  constructor(
    private readonly driver: TextureBridgeDriver<Lease, Texture>,
    private readonly decode: (value: unknown) => Lease | undefined,
    private readonly capacity: number,
  ) {}
  setReady(ready: boolean) { this.ready = ready }
  setGeneration(generation: number) {
    if (Number.isSafeInteger(generation) && generation > this.generation) this.generation = generation
  }
  get outstanding() { return this.entries.size }
  async offer(value: unknown): Promise<void> {
    const lease = this.decode(value)
    if (!lease) { this.driver.failure('invalid-frame'); return }
    const key = keyOf(lease)
    if (this.entries.has(key)) return
    if (this.entries.size >= this.capacity) { this.driver.failure('lease-capacity'); return }
    const entry: Entry<Lease> = { lease, referencesReleased: false }
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
      // An uncertain import stays bounded until Electron proves reference safety.
      this.driver.failure('texture-transfer')
    } finally { texture?.release() }
  }
  retryReleases() {
    for (const entry of this.entries.values()) if (entry.referencesReleased) this.sendRelease(entry)
  }
  private sendRelease(entry: Entry<Lease>) {
    try { this.driver.returnLease(entry.lease) }
    catch { this.driver.failure('release-channel') }
  }
  acknowledgeRelease(lease: TextureLeaseKey): boolean {
    const key = keyOf(lease)
    if (!this.entries.get(key)?.referencesReleased) return false
    this.entries.delete(key)
    return true
  }
}
