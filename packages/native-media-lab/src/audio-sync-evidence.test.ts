import { describe, it, expect } from 'vitest'
import { pulseCode, verifyAudioSync, verifyAudioCaptureAge } from './audio-sync-evidence.js'
describe('coded audio/visual oracle', () => {
  it('separates subscription startup from missing or foreign pulses during common observation', () => {
    const audio = Array.from({ length: 21 }, (_, index) => ({ atMs: 100_000 + index * 1000, code: index % 16 }))
    const video = audio.slice(2).map(pulse => ({ ...pulse, atMs: pulse.atMs - 40 }))
    const report = verifyAudioSync(video, audio, 20_000)
    expect(report.accepted).toBe(true)
    expect(report.comparedAudioPulses).toBe(19)
    const foreign = [...audio, ...audio.slice(3, 18).map(pulse => ({ ...pulse, atMs: pulse.atMs + 500 }))].sort((a, b) => a.atMs - b.atMs)
    expect(verifyAudioSync(video, foreign, 20_000).failures).toContain('unmatched coded pulses')
    expect(verifyAudioSync(video.slice(10), audio, 20_000).accepted).toBe(false)
  })
  it('requires a common monotonic clock and bounded capture-to-receiver age', () => {
    const capture = Array.from({ length: 10 }, (_, code) => ({ atMs: 100000 + code * 1000, code }))
    expect(verifyAudioCaptureAge(capture, capture.map(p => ({ ...p, atMs: p.atMs + 30 }))).accepted).toBe(true)
    expect(verifyAudioCaptureAge(capture, capture.map(p => ({ ...p, atMs: p.atMs - 30 }))).accepted).toBe(false)
    expect(verifyAudioCaptureAge(capture, capture.map(p => ({ ...p, atMs: p.atMs + 200 }))).accepted).toBe(false)
  })
  it('decodes all fixture frequencies without relying on transport timestamps', () => {
    for (let code = 0; code < 16; ++code) {
      const samples = Int16Array.from({ length: 480 }, (_, index) => 1500 * Math.sin(2 * Math.PI * (600 + code * 100) * index / 48_000))
      expect(pulseCode(samples).code).toBe(code)
    }
  })
  it('rejects skew, accumulating drift and wrong pulse identities', () => {
    const video = Array.from({ length: 601 }, (_, index) => ({ atMs: index * 1000, code: index % 16 }))
    expect(verifyAudioSync(video, video.map(p => ({ ...p, atMs: p.atMs + 40 })), 600_000).accepted).toBe(true)
    expect(verifyAudioSync(video, video.map(p => ({ ...p, atMs: p.atMs + 200 })), 600_000).failures).toContain('A/V skew exceeds 150 ms')
    expect(verifyAudioSync(video, video.map((p, i) => ({ ...p, atMs: p.atMs + i / 6 })), 600_000).failures).toContain('A/V drift exceeds 50 ms')
    expect(verifyAudioSync(video, video.map(p => ({ ...p, code: (p.code + 1) % 16 })), 600_000).accepted).toBe(false)
  })
})
