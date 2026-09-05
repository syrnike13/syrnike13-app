import { describe, expect, it } from 'vitest'
import { verifyViewer } from './verify-viewer.mjs'

function stallReport() {
  const samples = Array.from({ length: 31 }, (_, second) => ({
    time: second * 1000, phase: 'stall', room: 'connected',
    sdkConnected: true, sdkReconnects: 0,
    delivered: 4, retired: 0, quarantined: 0, backingBytes: 33292288,
    accepted: second === 0 ? 4 : 7, decoded: second * 60,
  }))
  return {
    frames: 100, failures: [], pending: 0, samples,
    final: { backingBytes: 0, room: 'connected', latencyP95Ms: 20 },
    transitions: [{ time: 0, phase: 'stall', frames: 3 },
      { time: 30000, phase: 'resume', frames: 3 }],
  }
}

describe('viewer stall acceptance', () => {
  it('rejects SDK recovery even if the owner snapshot still says connected', () => {
    const report = stallReport()
    report.samples.at(-1).sdkReconnects = 1
    expect(verifyViewer(report, 'stall', 45)).toContain('SDK Room disconnected or reconnected')
  })
  it('allows pre-stall GPU releases to settle before the held-reference plateau', () => {
    expect(verifyViewer(stallReport(), 'stall', 45)).toEqual([])
  })
  it('rejects continued reuse after the held-reference plateau starts', () => {
    const report = stallReport()
    report.samples.at(-1).accepted++
    expect(verifyViewer(report, 'stall', 45)).toContain(
      'Stall did not preserve fixed backing while decoding continued')
  })
  it('enforces the byte and slot limits even during settling', () => {
    const report = stallReport()
    report.samples[0].delivered = 5
    report.samples[0].backingBytes = 257 * 1024 * 1024
    expect(verifyViewer(report, 'stall', 45)).toContain('Pool bound exceeded')
  })
})
