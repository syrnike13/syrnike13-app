import { describe, expect, it, vi } from 'vitest'
import { LocalPreviewBridge } from './local-preview-bridge'
import { RemoteVideoBridge } from './remote-video-bridge'

const frame = (sequence = 1, generation = 1) => ({ version: 1, kind: 'local-preview',
  generation, sequence, revision: 1, slot: (sequence - 1) % 2,
  width: 1280, height: 720, timestamp: 1000, handle: 42,
  publicationGeneration: 7, sourceGeneration: 3 })
function setup() {
  const callbacks: Array<() => void> = []
  const driver = { hostEpoch: 1,
    importTexture: vi.fn((_lease: unknown, released: () => void) => {
      callbacks.push(released); return { release: vi.fn() }
    }),
    sendTexture: vi.fn(async (_texture: unknown, _metadata: unknown) => {}),
    returnLease: vi.fn(), failure: vi.fn(),
  }
  const bridge = new LocalPreviewBridge(driver)
  bridge.setReady(true)
  return { bridge, driver, callbacks }
}
describe('isolated local preview lease bridge', () => {
  it('keeps at most two outstanding imports across generations and requires Electron release proof', async () => {
    const { bridge, driver, callbacks } = setup()
    await bridge.offer(frame()); await bridge.offer(frame(2)); await bridge.offer(frame(3, 2))
    expect(driver.importTexture).toHaveBeenCalledTimes(2)
    expect(driver.failure).toHaveBeenCalledWith('lease-capacity')
    expect(bridge.acknowledgeRelease(frame())).toBe(false)
    callbacks[0]?.(); callbacks[0]?.()
    expect(driver.returnLease).toHaveBeenCalledTimes(1)
    bridge.retryReleases()
    expect(driver.returnLease).toHaveBeenCalledTimes(2)
    expect(bridge.acknowledgeRelease(frame(1, 2))).toBe(false)
    expect(bridge.acknowledgeRelease(frame())).toBe(true)
    expect(bridge.outstanding).toBe(1)
  })
  it('rejects remote metadata, oversize preview and handles outside the numeric contract', async () => {
    const { bridge, driver } = setup()
    await bridge.offer({ ...frame(), kind: 'remote-video' })
    await bridge.offer({ ...frame(), width: 1920 })
    await bridge.offer({ ...frame(), slot: 2 })
    await bridge.offer({ ...frame(), handle: Infinity })
    expect(driver.importTexture).not.toHaveBeenCalled()
    expect(driver.failure).toHaveBeenCalledTimes(4)
  })
  it('does not expose handles to renderer or touch the remote bridge state', async () => {
    const { bridge, driver } = setup()
    const remote = new RemoteVideoBridge(driver)
    await bridge.offer(frame())
    bridge.setGeneration(2)
    expect(remote.outstanding).toBe(0)
    expect(driver.sendTexture.mock.calls[0]?.[1]).toMatchObject({ kind: 'local-preview', publicationGeneration: 7, sourceGeneration: 3 })
    expect(driver.sendTexture.mock.calls[0]?.[1]).not.toHaveProperty('handle')
  })
  it('returns a stale undelivered frame exactly once and quarantines uncertain renderer transfers', async () => {
    const { bridge, driver } = setup()
    bridge.setGeneration(2)
    await bridge.offer(frame()); await bridge.offer(frame())
    expect(driver.importTexture).not.toHaveBeenCalled()
    expect(driver.returnLease).toHaveBeenCalledTimes(1)
    bridge.acknowledgeRelease(frame())
    driver.sendTexture.mockRejectedValue(new Error('renderer lost'))
    await bridge.offer(frame(2, 2))
    expect(bridge.outstanding).toBe(1)
    expect(driver.returnLease).toHaveBeenCalledTimes(1)
  })
})
