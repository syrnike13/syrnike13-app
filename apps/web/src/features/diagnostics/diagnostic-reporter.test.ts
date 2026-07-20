import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearDiagnosticEventsForTests,
  diagnosticEventCount,
  diagnosticEventsJsonForTests,
  recordDiagnosticEvent,
} from './diagnostic-reporter'

describe('diagnostic reporter', () => {
  beforeEach(clearDiagnosticEventsForTests)

  it('keeps a bounded event ring', () => {
    for (let index = 0; index < 900; index += 1) {
      recordDiagnosticEvent('voice', 'sample', { index })
    }
    expect(diagnosticEventCount()).toBe(800)
  })

  it('removes sensitive fields and values', () => {
    recordDiagnosticEvent('voice', 'failed', {
      token: 'secret',
      roomUrl: 'wss://private.example',
      code: 'screen_start_failed',
    })
    const serialized = diagnosticEventsJsonForTests()
    expect(serialized).toContain('screen_start_failed')
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('private.example')
  })

  it('redacts POSIX paths and file URLs from uploaded event text', () => {
    recordDiagnosticEvent('renderer', 'renderer_error', {
      message: 'failed at /Users/alice/private.txt',
      stack: 'at load (file:///home/alice/app/secrets.ts:42:7)',
    })

    const serialized = diagnosticEventsJsonForTests()
    expect(serialized).toContain('[redacted-path]')
    expect(serialized).not.toContain('/Users/alice')
    expect(serialized).not.toContain('file:///home/alice')
  })

  it('replaces an oversized event instead of growing the bundle without bound', () => {
    recordDiagnosticEvent('voice', 'oversized', {
      samples: Array.from({ length: 50 }, (_, index) => ({
        index,
        value: 'x '.repeat(2_000),
      })),
    })
    const serialized = diagnosticEventsJsonForTests()
    expect(serialized).toContain('event_too_large')
    expect(serialized.length).toBeLessThan(1_000)
  })

  it('collapses identical state snapshots and reports omitted repetitions', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-19T16:00:00Z'))
    try {
      const options = {
        dedupeKey: 'voice.session_snapshot',
        heartbeatMs: 30_000,
      }
      recordDiagnosticEvent('voice', 'session_snapshot', { connection: 'connected' }, options)
      recordDiagnosticEvent('voice', 'session_snapshot', { connection: 'connected' }, options)
      vi.advanceTimersByTime(1_000)
      recordDiagnosticEvent('voice', 'session_snapshot', { connection: 'failed' }, options)

      expect(diagnosticEventCount()).toBe(2)
      expect(diagnosticEventsJsonForTests()).toContain(
        '"repeated_events_omitted":1',
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
