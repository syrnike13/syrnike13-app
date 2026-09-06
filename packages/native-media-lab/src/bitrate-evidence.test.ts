import { describe, expect, it } from 'vitest'
import { isBitrateTeardownFrame, verifyBitrateEvidence } from './bitrate-evidence.js'

function fixture() {
  const samples = Array.from({ length: 40 }, (_, index) => ({
    elapsedMs: index * 500 + 500, profile: 4, generation: 1, encoderInstance: 7,
    width: 1920, height: 1080, fps: 60, targetBps: 8_000_000, appliedBps: 8_000_000,
    updates: 0, outcome: 0, warning: false, networkBps: 12_000_000,
    captureFrames: index * 30, encoderFrames: index * 30, encodedBytes: index * 500_000,
    consumed: index * 30, videoDepth: 1, bytes: 48_000_000, handles: 1000, threads: 100,
    privateBytes: 180_000_000, previewFrames: index * 10, previewChanges: index * 9,
    audioPackets: index * 50, gpuActive: false, gpuBatches: 0,
    previewStalled: false, remoteVoicePlayed: 0, reason: 0,
  }))
  const receiver = { frames: 1200, p95AgeMs: 25, maximumAgeMs: 45, maximumGapMs: 33,
    reconnects: 0, identities: ['video', 'audio'], minutes: [{ frames: 1200, p95AgeMs: 25 }], rtcSamples: [] }
  return { samples, receiver }
}
describe('full-interval fixed-preset acceptance', () => {
  it('excludes an SFU close placeholder only after an explicit complete measured interval', () => {
    expect(isBitrateTeardownFrame(2, 2, 180_000, 180_001, 1000, 180_000)).toBe(true)
    for (const ended of [NaN, 0, 90_000, 181_000])
      expect(isBitrateTeardownFrame(2, 2, ended, 180_001, 1000, 180_000)).toBe(false)
    expect(isBitrateTeardownFrame(1280, 720, 180_000, 180_001, 1000, 180_000)).toBe(false)
  })
  it('admits a short stable transport diagnostic without claiming the soak', () => {
    const { samples, receiver } = fixture()
    expect(verifyBitrateEvidence(samples, receiver, 20_000, 0).accepted).toBe(true)
    expect(verifyBitrateEvidence(samples, receiver, 1200_000, 0).accepted).toBe(false)
  })
  it('rejects even one transition replacement, oversized queue or old frame', () => {
    for (const mutation of ['encoder', 'preset', 'queue', 'age', 'subscription'] as const) {
      const { samples, receiver } = fixture()
      if (mutation === 'encoder') samples[12]!.encoderInstance = 8
      if (mutation === 'preset') samples[12]!.fps = 30
      if (mutation === 'queue') samples[12]!.videoDepth = 3
      if (mutation === 'age') receiver.maximumAgeMs = 1501
      if (mutation === 'subscription') receiver.identities.push('replacement')
      expect(verifyBitrateEvidence(samples, receiver, 20_000, 0).accepted).toBe(false)
    }
  })
  it('requires independent pixel/audio progress and finite resources', () => {
    for (const mutation of ['preview', 'audio', 'handles'] as const) {
      const { samples, receiver } = fixture()
      if (mutation === 'preview') for (const sample of samples) sample.previewChanges = 0
      if (mutation === 'audio') for (const sample of samples) sample.audioPackets = 0
      if (mutation === 'handles') for (const sample of samples.slice(-10)) sample.handles += 65
      expect(verifyBitrateEvidence(samples, receiver, 20_000, 0).accepted).toBe(false)
    }
  })
  it('requires an actual preview stall, resumed pixels and continuous remote playback', () => {
    const base = fixture()
    const samples = Array.from({ length: 360 }, (_, index) => {
      const elapsedMs = index * 500 + 500
      const updates = [30_000, 60_000, 120_000, 145_000, 170_000].filter(at => at <= elapsedMs).length
      const bitrate = [8_000_000, 4_000_000, 2_000_000, 2_500_000, 3_125_000, 3_900_000][updates]!
      const preview = Math.min(index, 39) + Math.max(0, index - 319)
      return { ...base.samples[0]!, elapsedMs, updates, appliedBps: bitrate, targetBps: bitrate,
        captureFrames: index * 30, encoderFrames: index * 30, audioPackets: index * 50,
        previewFrames: preview * 10, previewChanges: preview * 9,
        previewStalled: elapsedMs >= 20_000 && elapsedMs < 160_000, remoteVoicePlayed: index * 24_000 }
    })
    expect(verifyBitrateEvidence(samples, base.receiver, 180_000, 0, 'preview-stall').accepted).toBe(true)
    expect(verifyBitrateEvidence(samples, base.receiver, 180_000, 0).accepted).toBe(false)
    for (const mode of ['voice-stop', 'no-stall', 'no-resume'] as const) {
      const broken = samples.map((sample, index) => ({ ...sample,
        remoteVoicePlayed: mode === 'voice-stop' ? 0 : sample.remoteVoicePlayed,
        previewChanges: mode === 'no-stall' ? index : mode === 'no-resume' && index >= 319 ? 351 : sample.previewChanges,
      }))
      expect(verifyBitrateEvidence(broken, base.receiver, 180_000, 0, 'preview-stall').accepted).toBe(false)
    }
  })
})
