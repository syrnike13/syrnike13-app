import { beforeEach, describe, expect, it } from 'vitest'

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
})
