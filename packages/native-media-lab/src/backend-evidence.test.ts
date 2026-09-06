import { describe, expect, it } from 'vitest'
import { decodeGpuContentionEvidence, verifyBackendEvidence } from './backend-evidence.js'

const summary = { attempts: 1, switches: 0, pauses: 0, delivered: 700, maximumGenerations: 1,
  liveGenerations: 0, dxgiAcquired: 700, dxgiReleased: 700, maximumHoldUs: 250, holdBudgetUs: 50_000 }
const sample = { elapsedMs: 120_000, attempts: 1, switches: 0, liveGenerations: 1, retainedFrames: 1,
  handles: 800, threads: 90, dxgiTextures: 7, backend: 'dxgi' }
const stream = { frames: 7201, width: 1920, height: 1080, p95LatencyMs: 30, firstFrameAfterStartMs: 3000, lastFrameAfterStartMs: 123000 }
const observer = { reconnects: 0, tracks: { subscribed: 3 }, video: { p95LatencyMs: 30,
  decodedStreams: [{ ...stream, frames: 300 }, stream] } }
const mode = 'screen-gpu-dxgi-monitor-1080p60'
describe('backend observer evidence', () => {
  it('requires completed GPU work with the fixed allocation', () => {
    expect(decodeGpuContentionEvidence({ batches: 1, allocatedBytes: 16 * 1024 * 1024 }).batches).toBe(1)
    for (const value of [undefined, { batches: 0, allocatedBytes: 16 * 1024 * 1024 },
      { batches: 1, allocatedBytes: 0 }]) expect(() => decodeGpuContentionEvidence(value)).toThrow()
  })
  it('rejects impossible native counters at the report boundary', () => {
    for (const value of [-1, NaN, Infinity, 0.5])
      expect(() => verifyBackendEvidence({ ...summary, maximumHoldUs: value }, [sample], observer, mode)).toThrow()
  })
  it('accepts measured decoding with bounded capture ownership', () => {
    expect(verifyBackendEvidence(summary, [sample], observer, mode).accepted).toBe(true)
  })
  it('keeps diagnostic observer runs out of resource acceptance', () => {
    expect(verifyBackendEvidence(summary, [sample], { ...observer, diagnosticOnly: true }, mode).accepted).toBe(false)
  })
  it('requires a real warmup and checks the full measured publication age', () => {
    const cold = { ...observer, video: { ...observer.video, p95LatencyMs: 1000,
      decodedStreams: [{ ...stream, frames: 300, p95LatencyMs: 1000 }, stream] } }
    expect(verifyBackendEvidence(summary, [sample], cold, mode).accepted).toBe(true)
    expect(verifyBackendEvidence(summary, [sample], { ...cold, video: { ...cold.video,
      decodedStreams: [stream, { ...stream, p95LatencyMs: 151 }] } }, mode).accepted).toBe(false)
    expect(verifyBackendEvidence(summary, [sample], { ...cold, video: { ...cold.video,
      decodedStreams: [{ ...stream, frames: 0 }, stream] } }, mode).accepted).toBe(false)
  })
  it('rejects nominal fps when actual decoding is slow', () => {
    const slow = { ...observer, video: { ...observer.video, decodedStreams: [stream, { ...stream, frames: 3601 }] } }
    expect(verifyBackendEvidence(summary, [sample], slow, mode).accepted).toBe(false)
  })
  it('rejects missing releases, retained generations, and changed hold budget', () => {
    for (const change of [{ dxgiReleased: 699 }, { liveGenerations: 1 }, { maximumGenerations: 3 }, { holdBudgetUs: 100000 }, { maximumHoldUs: 50001 }])
      expect(verifyBackendEvidence({ ...summary, ...change }, [sample], observer, mode).accepted).toBe(false)
  })
  it('rejects reconnects and replacement publications', () => {
    expect(verifyBackendEvidence(summary, [sample], { ...observer, reconnects: 1 }, mode).accepted).toBe(false)
    expect(verifyBackendEvidence(summary, [sample], { ...observer, tracks: { subscribed: 5 } }, mode).accepted).toBe(false)
  })
  it('rejects partial switch proof and growing resources', () => {
    const switching = { ...summary, attempts: 31, switches: 30 }
    const switchObserver = { ...observer, video: { ...observer.video, decodedStreams: [stream,
      { ...stream, frames: 22501, lastFrameAfterStartMs: 378000 }] } }
    expect(verifyBackendEvidence(switching, [sample], observer, 'switch').accepted).toBe(false)
    const samples = Array.from({ length: 31 }, (_, cycle) => ({ ...sample, elapsedMs: cycle * 12500,
      switches: cycle, attempts: cycle + 1, handles: 800 + cycle * 2, backend: cycle % 2 ? 'dxgi' : 'wgc' }))
    expect(verifyBackendEvidence(switching, samples, switchObserver, 'switch').accepted).toBe(false)
    expect(verifyBackendEvidence(switching, samples.map(value => ({ ...value, handles: 800 })), switchObserver, 'switch').accepted).toBe(true)
    const shrinking = samples.map((value, cycle) => ({ ...value, handles: 800, threads: 100 - Math.floor(cycle / 2) }))
    expect(verifyBackendEvidence(switching, shrinking, switchObserver, 'switch').accepted).toBe(true)
    const regrowing = shrinking.map((value, cycle) => ({ ...value,
      threads: cycle < 16 ? value.threads : 92 + Math.floor((cycle - 16) / 2) }))
    expect(verifyBackendEvidence(switching, regrowing, switchObserver, 'switch').accepted).toBe(false)
  })
})
