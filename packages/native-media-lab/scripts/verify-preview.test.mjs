import { describe, expect, it } from 'vitest'
import { verifyPreview } from './verify-preview.mjs'

function evidence() {
  const samples = Array.from({ length: 101 }, (_, i) => ({ time: i * 100, frames: i * 3,
    backingBytes: 7_471_104, outstanding: 1, pending: 1, quarantined: 0,
    sdkReconnects: 0, sdkConnected: true, publicationFailures: 0, encoderStalls: 0,
    publicationDepth: 1, publicationBytes: 40_000_000, publicationConsumed: i * 3 + 31,
    publicationActive: true, done: false, accepted: i * 3, rendererHeld: 0 }))
  const final = { ...samples.at(-1), done: true, backingBytes: 0, outstanding: 0, pending: 0,
    publicationDepth: 0, captureActive: 0, capturePending: 0, conversionSlots: 0,
    encoderInputSlots: 0, encoderOutputSlots: 0, poolDrops: 0 }
  return { preview: { samples, final, frames: 300, failures: [], outstanding: 0, transitions: [], cycles: 0 },
    observer: { subscriptions: ['TR_screen'], reconnects: 0, frames: 300, averageFps: 30,
      p95AgeMs: 40, maximumGapMs: 60, samples: Array.from({ length: 10 }, () => ({ frames: 30 })),
      failures: [], sourceSizes: ['1920x1080'] } }
}
describe('preview contention acceptance', () => {
  it('requires remote decoded delivery, not healthy publication counters alone', () => {
    const { preview, observer } = evidence()
    expect(verifyPreview(preview, observer, 'normal')).toEqual([])
    observer.frames = 0
    expect(verifyPreview(preview, observer, 'normal')).toContain('Observer delivery below 20 FPS budget')
  })
  it('rejects growing pools, a reconnect and outstanding stop resources', () => {
    const { preview, observer } = evidence()
    preview.samples[50].backingBytes = 9 * 1024 * 1024
    preview.samples[50].sdkReconnects = 1
    preview.final.pending = 1
    expect(verifyPreview(preview, observer, 'normal')).toEqual(expect.arrayContaining([
      'Preview texture bound exceeded', 'Publication became unhealthy', 'Preview resources leaked after stop',
    ]))
  })
  it('requires publication progress during a held preview, with no new preview allocations', () => {
    const { preview, observer } = evidence()
    preview.final.poolDrops = 200
    for (const sample of preview.samples) {
      sample.rendererHeld = 2; sample.outstanding = 2; sample.pending = 0; sample.accepted = 2
    }
    expect(verifyPreview(preview, observer, 'never-release')).toEqual([])
    preview.samples[80].accepted++
    expect(verifyPreview(preview, observer, 'never-release')).toContain('Stalled preview kept allocating frames')
    for (const sample of preview.samples) sample.publicationConsumed = 100
    expect(verifyPreview(preview, observer, 'never-release')).toContain('Publication progress while preview stalled was not proven')
  })
  it('does not accept a pressure label without resource reclamation and sender progress', () => {
    const { preview, observer } = evidence()
    expect(verifyPreview(preview, observer, 'pressure')).toContain('Publication did not progress under preview pressure')
  })
})
