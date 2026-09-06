import { describe, expect, it } from 'vitest'
import { rewriteLabCandidate, VideoPacketBudget } from './bitrate-network-shaper.js'
describe('finite lab network link', () => {
  it('limits real datagram bytes and discards expired backlog', () => {
    const budget = new VideoPacketBudget()
    let bytes = 0
    budget.tick(0, 800_000)
    for (let i = 0; i < 100; ++i) budget.offer(Buffer.alloc(1000), 0, data => { bytes += data.length })
    expect(budget.depth).toBe(64)
    expect(budget.droppedPackets).toBe(36)
    budget.tick(20, 800_000)
    expect(bytes).toBe(2000)
    budget.tick(41, 800_000)
    expect(budget.depth).toBe(0)
    expect(bytes).toBe(2000)
    expect(budget.maximumDeliveryAgeMs).toBe(20)
  })
  it('advertises only the owned UDP proxy, so TCP cannot bypass the test', () => {
    expect(rewriteLabCandidate('candidate:1 1 udp 1 127.0.0.1 7888 typ host', 7888, 7890))
      .toBe('candidate:1 1 udp 1 127.0.0.1 7890 typ host')
    expect(rewriteLabCandidate('candidate:2 1 tcp 1 127.0.0.1 7887 typ host', 7888, 7890)).toBeUndefined()
  })
})
