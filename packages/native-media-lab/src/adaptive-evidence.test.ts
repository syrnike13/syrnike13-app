import { describe, expect, it } from 'vitest'
import { verifyAdaptiveEvidence } from './adaptive-evidence.js'

function fixture(contention = false) {
  const samples = Array.from({ length: contention ? 2400 : 240 }, (_, index) => ({
    elapsedMs: (index + 1) * 500, profile: 4, generation: 1,
    desiredRevision: 3, appliedRevision: 3, videoDepth: 0, bytes: 32 * 1024 * 1024,
    handles: 800, threads: 60, consumed: index * 20, keyframeRequests: 1,
    contentionBatches: contention ? index : 0, contentionActive: contention && index % 120 < 20,
  }))
  const observer = { video: { latencyMinutes: Array.from({ length: contention ? 20 : 2 }, (_, minute) => ({ minute, frames: 2000, p95Ms: 25 })), decodedStreams: [{ frames: 2000, width: 1920, height: 1080,
    subscribedAfterStartMs: 100, firstFrameAfterStartMs: 200 }] } }
  return { samples, observer }
}
describe('adaptive observer evidence', () => {
  it('rejects growing latency despite healthy local queues', () => {
    const f = fixture(true)
    f.observer.video.latencyMinutes.forEach((minute, index) => { minute.p95Ms += index * 4 })
    expect(verifyAdaptiveEvidence(f.samples, f.observer, true).failures)
      .toContain('latency grew during contention or minute evidence is missing')
  })
  it('accepts bounded full-duration contention and rejects linear resource growth', () => {
    const f = fixture(true)
    expect(verifyAdaptiveEvidence(f.samples, f.observer, true).accepted).toBe(true)
    f.samples.forEach((sample, index) => { sample.handles += index / 10 })
    expect(verifyAdaptiveEvidence(f.samples, f.observer, true).failures)
      .toContain('equal-profile resources grew beyond bounded allowance')
  })
  it('does not accept local frame consumption as replacement decoding', () => {
    const f = fixture()
    f.samples.slice(100).forEach(sample => { sample.generation = 2 })
    expect(verifyAdaptiveEvidence(f.samples, f.observer, false).failures)
      .toContain('a replacement did not decode remotely')
  })
  it('rejects missing recovery, early observer completion and change storms', () => {
    const f = fixture()
    f.samples.forEach((sample, index) => { sample.generation = Math.floor(index / 4) + 1; sample.profile = 0 })
    const result = verifyAdaptiveEvidence(f.samples.slice(0, 120), f.observer, false)
    expect(result.failures).toContain('insufficient adaptive observation duration')
    expect(result.failures).toContain('profile change rate exceeded')
    expect(result.failures).toContain('quality did not recover to restored user ceiling')
  })
})
