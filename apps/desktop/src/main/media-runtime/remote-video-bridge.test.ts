import { describe, expect, it, vi } from 'vitest'
import { RemoteVideoBridge } from './remote-video-bridge'

const lease = (sequence = 1, generation = 1) => ({ version: 1, generation, sequence,
  slot: (sequence - 1) % 4, width: 1920, height: 1080, timestamp: 1000, ingressUs: 900, handle: 42,
  publicationId: 'publication', participantIdentity: 'publisher' })
function setup() {
  const callbacks: Array<() => void> = []
  const driver = {
    hostEpoch: 7,
    importTexture: vi.fn((_lease: unknown, released: () => void) => {
      callbacks.push(released)
      return { release: vi.fn() }
    }),
    sendTexture: vi.fn(async (_texture: unknown, _metadata: unknown) => {}),
    returnLease: vi.fn(), failure: vi.fn(),
  }
  const bridge = new RemoteVideoBridge(driver)
  bridge.setReady(true)
  return { callbacks, driver, bridge }
}
describe('RemoteVideoBridge', () => {
  it('only recycles after Electron safety proof, then retains release until acknowledgement', async () => {
    const { bridge, callbacks, driver } = setup()
    await bridge.offer(lease())
    expect(driver.returnLease).not.toHaveBeenCalled()
    expect(bridge.acknowledgeRelease(lease())).toBe(false)
    callbacks[0]?.()
    expect(driver.returnLease).toHaveBeenCalledTimes(1)
    bridge.retryReleases()
    expect(driver.returnLease).toHaveBeenCalledTimes(2)
    expect(bridge.outstanding).toBe(1)
    expect(bridge.acknowledgeRelease(lease(1, 2))).toBe(false)
    expect(bridge.acknowledgeRelease(lease())).toBe(true)
    expect(bridge.acknowledgeRelease(lease())).toBe(false)
    expect(bridge.outstanding).toBe(0)
  })
  it('quarantines timed-out transfers and keeps a four-lease bound across generations', async () => {
    const { bridge, driver } = setup()
    driver.sendTexture.mockRejectedValue(new Error('timeout'))
    for (let i = 1; i <= 4; ++i) await bridge.offer(lease(i))
    bridge.setGeneration(2)
    await bridge.offer(lease(5, 2))
    expect(driver.importTexture).toHaveBeenCalledTimes(4)
    expect(driver.returnLease).not.toHaveBeenCalled()
    expect(bridge.outstanding).toBe(4)
    expect(driver.failure).toHaveBeenCalledWith('lease-capacity')
  })
  it('rejects duplicate imports and never exports a native handle to the renderer', async () => {
    const { bridge, driver } = setup()
    await bridge.offer(lease()); await bridge.offer(lease())
    expect(driver.importTexture).toHaveBeenCalledTimes(1)
    expect(driver.sendTexture.mock.calls[0]?.[1]).toMatchObject({ hostEpoch: 7, sequence: 1 })
    expect(driver.sendTexture.mock.calls[0]?.[1]).not.toHaveProperty('handle')
  })
  it('returns undelivered stale frames safely and validates protocol bounds', async () => {
    const { bridge, driver } = setup()
    bridge.setGeneration(2)
    await bridge.offer(lease())
    expect(driver.importTexture).not.toHaveBeenCalled()
    expect(driver.returnLease).toHaveBeenCalledTimes(1)
    await bridge.offer({ ...lease(), slot: 4 })
    await bridge.offer({ ...lease(), version: 2 })
    expect(driver.failure).toHaveBeenCalledTimes(2)
  })
})
